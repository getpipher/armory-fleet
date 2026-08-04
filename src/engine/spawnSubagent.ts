// src/engine/spawnSubagent.ts
import type { AgentDef, ThinkingLevel } from "../registry/frontmatter.ts";
import type { FleetRunStatus, TodoSyncPort } from "../todo-sync/port.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";
import type { VisionPort } from "../vision/port.ts";
import type { BackendRegistry } from "../backend/port.ts";
import { genRunId, RunRegistry } from "./run-registry.ts";
import { createTurnBudget, DEFAULT_MAX_TURNS } from "./turn-budget.ts";
import type { SingleSlotLock } from "./concurrency-lock.ts";
import type { RunLog } from "../runtime/run-log.ts";
import { buildToolEvent } from "../runtime/run-log.ts";
import { resolveAgentModel, type ModelRegistryLike } from "../tiers/resolve.ts";
import { TierRegistry } from "../tiers/tier-registry.ts";

const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** SPEC-6-1: derive context-token count from a usage object. Prefer totalTokens; fall back to sum. */
function calcContextTokens(u: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
  return u.totalTokens || ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
}

/** No-op ports used when a caller omits them (e.g. SPEC-1 unit tests). Production (index.ts) passes real ports. */
const NOOP_MEMORY_PORT: MemoryHydratePort = { renderScopes: () => "" };
const NOOP_VISION_PORT: VisionPort = {
  isMultimodal: () => false,
  isConfigured: () => false,
  delegate: async () => ({ ok: false, error: "no vision port configured" }),
};

/** Minimal event shape the engine reads from a child session (decoupled from pi's internal event types). */
export interface ChildSessionEvent {
  type: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
  /** Emitted by a backend on session init (SPEC-3). Drives runRecord.backendSessionId. */
  backendSessionId?: string;
}

export interface ChildSession {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: ChildSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  /** SPEC-5b-4: optional mid-run steering. Pi backend forwards the native SDK `steer()`; claude omits. */
  steer?(text: string): Promise<void>;
  /** SPEC-5b-4: optional live streaming flag. Pi backend forwards the native SDK getter; claude omits. */
  readonly isStreaming?: boolean;
  /** SPEC-6-2: is the underlying session still active (not disposed/ended/killed)? */
  isAlive?(): boolean;
}

/** SPEC-5b-4: narrow live-session handle retained on RunRecord while status === "running".
 *  Exposes only redirect/cancel/observe/liveness — deliberately no `prompt` or `dispose`
 *  (the panel must not start new prompts or tear down the session). */
export interface LiveSessionHandle {
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(handler: (e: ChildSessionEvent) => void): () => void;
  readonly isStreaming: boolean;
  readonly supportsSteer: boolean;
  /** SPEC-6-2: is the underlying session still active (not disposed/ended/killed)? */
  isAlive(): boolean;
}

/** SPEC-5b-4: wrap a ChildSession into a narrow LiveSessionHandle for the panel.
 *  `supportsSteer` is derived from whether the backend implemented the optional `steer`. */
export function toLiveHandle(session: ChildSession): LiveSessionHandle {
  return {
    steer: (text) => session.steer ? session.steer(text) : Promise.reject(new Error("steer not supported on this backend")),
    abort: () => session.abort(),
    subscribe: (h) => session.subscribe(h),
    get isStreaming() { return session.isStreaming ?? false; },
    get supportsSteer() { return typeof session.steer === "function"; },
    isAlive: () => typeof (session as { isAlive?: () => boolean }).isAlive === "function"
      ? (session as { isAlive: () => boolean }).isAlive() : true,
  };
}

export interface ChildSessionOpts {
  cwd: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools: string[];
  rolePrompt: string;
  skills: string[];
  task: string;
  agent: AgentDef;
  memoryPort: MemoryHydratePort;
  visionPort: VisionPort;
}

export interface ChildSessionFactory {
  create(opts: ChildSessionOpts): Promise<{ session: ChildSession; model: string }>;
}

export interface SpawnOptions {
  agent: string;
  task: string;
  todoId?: string;
  track?: boolean; // default true
  model?: string; // override
  maxTurns?: number; // default 20
  registry: Map<string, AgentDef>;
  todoSync: TodoSyncPort;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory — engine looks up by agentDef.backend
  parentModel: { provider: string; id: string };
  parentCwd: string;
  memoryPort?: MemoryHydratePort;
  visionPort?: VisionPort;
  signal?: AbortSignal;
  onEvent?: (e: ChildSessionEvent) => void;
  /** SPEC-4: when set, this spawn is a lifecycle phase child. It links to this lifecycle todo
   *  (not creates a new one) and finishRun skips mark-done/revert — the lifecycle engine owns
   *  the lifecycle todo's status + progress block. */
  lifecycleTodoId?: string;
  /** SPEC-4: when set (lifecycle phase child), override the agent's `skills` frontmatter with
   *  the lifecycle's merged phase skill bundle (Q1=B) + route to the phase's resolved backend
   *  (Q4=C) instead of the agent's `backend`. */
  skillsOverride?: string[];
  backendOverride?: "pi" | "claude";
  /** SPEC-5b-1: per-run conversation journal. When set, spawnSubagent writes run:meta →
   *  message/tool → run:ended events. Absent = no journal (unit tests stay clean). */
  runLog?: RunLog;
  /** SPEC-5b-1: when set, the new run is a resume of this prior runId (written to run:ended + RunRecord.resumedFrom). */
  resumeLink?: string;
  /** SPEC-5b-1: when set, the new run is a fork of this prior runId (written to run:ended + RunRecord.forkedFrom). */
  forkLink?: string;
  /** SPEC-6-1: tier registry for model-tier resolution. Optional — existing callers without it use agent.model/parent fallback. */
  tierRegistry?: TierRegistry;
  /** SPEC-6-1: model catalog for contextFloor filtering. Optional — absent means no catalog filtering. */
  modelRegistry?: ModelRegistryLike;
  /** SPEC-6-3: workflow adapter tier override — replaces agent.tier before model resolution. */
  tierOverride?: string;
}

export interface SpawnResult {
  status: FleetRunStatus;
  finalText: string;
  runId: string;
  todoId: string | null;
  agent: string;
  model: string;
  durationMs: number;
  tokenTotal: number;
  /** SPEC-6-1: cumulative $ (usage.cost.total) for this run. */
  costTotal?: number;
  /** SPEC-6-1: final context tokens (calcContextTokens of the last usage). */
  contextTokens?: number;
  error?: string;
}

export async function spawnSubagent(opts: SpawnOptions): Promise<SpawnResult> {
  const track = opts.track ?? true;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();

  // concurrency=1 (SPEC-1 §9.2) — peek before generating a runId so a rejected
  // call doesn't mint a discarded id; the held id is named in the message.
  const busyId = opts.lock.current();
  if (busyId !== null) {
    return fail("", startedAt, `a subagent is already running (concurrency=1 in v0.1); wait for ${busyId} to finish or abort it first`, opts.agent);
  }
  const runId = genRunId();
  if (!opts.lock.tryAcquire(runId)) {
    return fail("", startedAt, "concurrency lock unexpectedly unavailable", opts.agent);
  }

  try {
    // resolve agent
    const agentDef = opts.registry.get(opts.agent);
    if (!agentDef) {
      const available = [...opts.registry.keys()].sort().join(", ");
      return fail(runId, startedAt, `agent '${opts.agent}' not in registry; available: ${available}`, opts.agent);
    }

    // SPEC-3: route via the backend registry; fail fast if the backend is missing/unavailable.
    // SPEC-4: a lifecycle phase child may override the backend (Q4=C) + the skill bundle (Q1=B).
    const backendId = opts.backendOverride ?? agentDef.backend;
    const backend = opts.backendRegistry.get(backendId);
    if (!backend || !backend.available()) {
      const note = backend?.versionInfo()?.note ?? "not registered";
      return fail(runId, startedAt, `backend '${backendId}' unavailable: ${note}`, opts.agent);
    }
    // SPEC-4: when a lifecycle provides a skills override, clone the agentDef so the factory's
    // skillsOverride (buildChildLoader reads agent.skills) loads the phase's bundle, not the agent's.
    const childAgent = opts.skillsOverride ? { ...agentDef, skills: opts.skillsOverride } : agentDef;

    // SPEC-6-1: resolve model via tier registry (Q4 precedence + Q5 contextFloor/catalog filter).
    // SPEC-6-3: workflow tierOverride replaces agent.tier before resolution.
    const effectiveAgent = opts.tierOverride
      ? { ...agentDef, tier: opts.tierOverride }
      : agentDef;
    const resolved = resolveAgentModel(
      effectiveAgent, opts.model, opts.parentModel,
      opts.tierRegistry ?? new TierRegistry({ tiers: [], agents: new Map() }),
      opts.modelRegistry ?? { find: () => undefined },
    );
    if ("error" in resolved) {
      return fail(runId, startedAt, resolved.error, opts.agent);
    }
    const model = resolved.model;
    const tier = resolved.tier;
    const candidates = resolved.candidates ?? [model];

    // child tools pass through UNFILTERED — the single-writer `todo`-exclusion is enforced
    // downstream by the child factory's `excludeTools: ["todo"]` (SPEC-2 §9.1 hardening).
    const tools = childAgent.tools ?? PI_DEFAULT_TOOLS;
    const memoryPort = opts.memoryPort ?? NOOP_MEMORY_PORT;
    const visionPort = opts.visionPort ?? NOOP_VISION_PORT;

    // run record
    opts.runRegistry.add({
      runId, agent: agentDef.name, model, task: opts.task, track,
      todoId: null, status: "running", startedAt,
      tier: tier?.name, costTotal: 0, contextTokens: 0,
      cwd: opts.parentCwd, backend: backendId,
    });

    // todo-sync (before) — only when both caller tracks AND agent allows todoSync
    let priorStatus: string | undefined;
    let todoId: string | null = null;
    try {
      const link = await opts.todoSync.linkOrCreateRunTodo({
        runId, agent: agentDef.name, task: opts.task,
        todoId: opts.lifecycleTodoId ?? opts.todoId, track: track && agentDef.todoSync,
      });
      todoId = link.todoId;
      priorStatus = link.priorStatus;
      opts.runRegistry.update(runId, { todoId });
    } catch (e) {
      return await finishRun(opts, runId, startedAt, "failed", "", todoId, priorStatus, (e as Error).message, agentDef.name, model);
    }

    // SPEC-6-1: fallback retry loop — try candidates[0], on rejection retry candidates[1], etc.
    let session: ChildSession | undefined;
    let lastErr: Error | undefined;
    for (const cand of candidates) {
      try {
        const result = await backend.factory.create({
          cwd: opts.parentCwd,
          model: cand,
          thinkingLevel: childAgent.thinkingLevel,
          tools,
          rolePrompt: childAgent.rolePrompt,
          skills: childAgent.skills ?? [],
          task: opts.task,
          agent: childAgent,
          memoryPort,
          visionPort,
        });
        session = result.session;
        break;
      } catch (e) { lastErr = e as Error; }
    }
    if (!session) {
      return await finishRun(opts, runId, startedAt, "failed", "", todoId, priorStatus, `backend create failed: ${lastErr?.message ?? "unknown"}`, agentDef.name, model, 0, 0, 0);
    }

    // SPEC-5b-4: retain a narrow live-session handle on the run record so the panel can
    // steer/abort mid-flight. Wrap abort so the local `aborted` flag is set when the panel
    // calls handle.abort() (not just the signal path) — otherwise finishRun reports
    // "completed" instead of "aborted" on a user-initiated Stop. Cleared by finishRun.
    let aborted = false;
    const handle = toLiveHandle(session);
    handle.abort = async () => { aborted = true; await session.abort(); };
    opts.runRegistry.update(runId, { session: handle });

    const budget = createTurnBudget(maxTurns);
    let finalText = "";
    let tokenTotal = 0;
    let costTotal = 0;
    let contextTokens = 0;
    let turnIdx = -1;
    // #26/#22: declared before subscribe() because some child sessions emit events
    // synchronously inside subscribe() (temporal-dead-zone guard).
    let modelError: string | undefined;   // model-call failure surfaced via stopReason "error"
    let sawAssistantMessage = false;      // #22: did the child emit any assistant message_end at all?

    const onSignalAbort = (): void => { aborted = true; void session.abort(); };
    opts.signal?.addEventListener("abort", onSignalAbort);

    const unsub = session.subscribe((e) => {
      if (e.type === "session_init" && e.backendSessionId) {
        opts.runRegistry.update(runId, { backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey });
        try {
          opts.runLog?.append(runId, { type: "run:meta", runId, agent: agentDef.name, model, task: opts.task, startedAt, track, todoId, backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey, cwd: opts.parentCwd, pid: (session as { proc?: { pid?: number } }).proc?.pid });
        } catch { /* best-effort */ }
      } else if (e.type === "turn_start") {
        turnIdx++;
      } else if (e.type === "turn_end") {
        if (budget.consume()) void session.abort();
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        sawAssistantMessage = true;
        const text = e.message.content?.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        // #26/#22: a model-call failure (401, provider down, rate limit) surfaces as
        // stopReason "error". The SDK retries internally; if it still ends with an error
        // stopReason, capture it so the run is marked failed (not completed-with-empty) —
        // the controller gets an actionable error instead of "(no tool output)".
        const stopReason = (e.message as { stopReason?: string }).stopReason;
        if (stopReason === "error") {
          modelError = text || `model call ended with stopReason 'error' (provider/auth failure or rate limit) for model '${model}'`;
        } else {
          if (text) finalText = text;
        }
        // SPEC-5b-2 (Q9): accumulate REAL tokens (input+output+cacheRead+cacheWrite), not cost.total (dollars).
        const u = e.message.usage;
        const turnTokens = (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
        if (turnTokens > 0) {
          tokenTotal += turnTokens;
        }
        // SPEC-6-1: accumulate cost + context tokens.
        const cost = u?.cost?.total ?? 0;
        costTotal += cost;
        contextTokens = calcContextTokens(u ?? {});
        opts.runRegistry.update(runId, { costTotal, contextTokens, tokenTotal });
        try {
          opts.runLog?.append(runId, { type: "message", role: "assistant", text, usage: { total: turnTokens, input: u?.input, output: u?.output, cacheRead: u?.cacheRead, cacheWrite: u?.cacheWrite, cost: u?.cost }, turnIndex: turnIdx });
        } catch { /* best-effort */ }
        // SPEC-6-1: cap abort — if costTotal exceeds tier.costCap, abort + flag budget_exceeded.
        if (tier?.costCap && costTotal > tier.costCap) {
          aborted = true;
          void session.abort();
        }
      } else if (e.type === "tool_execution_end") {
        try {
          opts.runLog?.append(runId, buildToolEvent((e as any).toolName, (e as any).args, (e as any).result, (e as any).isError ?? false, turnIdx));
        } catch { /* best-effort */ }
      }
      opts.onEvent?.(e);
    });

    let runError: string | undefined;
    try {
      await session.prompt(opts.task);
    } catch (e) {
      runError = (e as Error).message;
    } finally {
      unsub();
      opts.signal?.removeEventListener("abort", onSignalAbort);
      session.dispose();
    }

    let status: FleetRunStatus;
    let error: string | undefined;
    if (aborted) {
      status = "aborted";
      error = tier?.costCap && costTotal > tier.costCap ? `budget_exceeded (cost $${costTotal.toFixed(4)} > cap $${tier.costCap})` : "aborted by user";
    } else if (budget.count() >= maxTurns) {
      // #25: surface a coherent partial, not a mid-sentence 200-char cut. The controller reads
      // `res.error` (the tool surfaces error, not finalText, for failed runs), so the partial must
      // live here. 4000 chars (~600 tokens) is enough for any structured summary the model emitted;
      // a truncation marker names the run log for the full output. (The wind-down nudge — injecting
      // a "you have ~N turns left, emit your partial now" message before the hard cut — is a
      // future enhancement tracked in #25; it needs mid-loop injection semantics.)
      const PARTIAL_WINDOW = 4000;
      const partial = finalText.length > PARTIAL_WINDOW
        ? finalText.slice(0, PARTIAL_WINDOW) + "\n…(partial truncated — see run log for full output)"
        : finalText;
      status = "failed";
      error = `hit turn budget (${maxTurns}) mid-task; partial result:\n${partial}`;
    } else if (runError) {
      status = "failed";
      error = runError;
    } else if (modelError) {
      // #26: a 401/provider/rate-limit failure that the SDK surfaced via stopReason "error"
      // after exhausting retries. Without this, the run fell through to `completed` with an
      // empty finalText — the controller saw "(no tool output)" and couldn't tell a broken
      // model from a no-op run.
      //
      // Precedence note (PR #30 review): a late error-stop overrides a prior successful turn.
      // If turn 1 set finalText (valid output) and turn 2 hit stopReason "error", the run is
      // marked failed with the error — the run IS incomplete, and the error is more actionable
      // to the controller than a partial result. finalText is preserved (not cleared) so
      // finishRun + the run log still carry the partial; only the surfaced status is failed.
      // Gating this on `!finalText` (only fail if no prior output) is a future design call, not
      // this fix — the current "last error wins" is the defensible default.
      status = "failed";
      error = modelError;
    } else if (!sawAssistantMessage) {
      // #22: prompt() resolved cleanly but the child produced NO assistant message_end at all.
      // A real agent loop always emits at least one assistant message; zero means a silent
      // failure (provider hung, empty response, premature exit). Treat as a structured
      // EMPTY_RESULT so orchestration can escalate models or retry, rather than silently
      // succeeding with empty output the controller can't distinguish from a no-op.
      status = "failed";
      error = `EMPTY_RESULT: child session produced no assistant output for model '${model}' (possible provider/auth failure, empty response, or premature exit)`;
    } else {
      status = "completed";
    }

    return await finishRun(opts, runId, startedAt, status, finalText, todoId, priorStatus, error, agentDef.name, model, tokenTotal, costTotal, contextTokens);
  } finally {
    opts.lock.release();
  }
}

function fail(runId: string, startedAt: number, message: string, agent: string): SpawnResult {
  return {
    status: "failed", finalText: "", runId, todoId: null, agent,
    model: "", durationMs: Date.now() - startedAt, tokenTotal: 0, error: message,
  };
}

/** SPEC-6-2: guard against double-finishRun (abort-then-complete). */
const finalizedRunIds = new Set<string>();

async function finishRun(
  opts: SpawnOptions, runId: string, startedAt: number,
  status: FleetRunStatus, finalText: string, todoId: string | null, priorStatus: string | undefined,
  error: string | undefined, agentName: string, model: string, tokenTotal = 0, costTotal = 0, contextTokens = 0,
): Promise<SpawnResult> {
  if (finalizedRunIds.has(runId)) {
    // Already finalized — return the existing registry record's result without re-appending.
    const existing = opts.runRegistry.get(runId);
    return {
      status: existing?.status ?? status, finalText: existing?.resultSummary ?? finalText,
      runId, todoId, agent: agentName, model,
      durationMs: existing?.endedAt ? existing.endedAt - startedAt : Date.now() - startedAt,
      tokenTotal, costTotal, contextTokens, error,
    };
  }
  finalizedRunIds.add(runId);

  const endedAt = Date.now();
  opts.runRegistry.update(runId, {
    status, endedAt, resultSummary: finalText.slice(0, 120),
    resumedFrom: opts.resumeLink, forkedFrom: opts.forkLink,
    session: undefined,   // SPEC-5b-4: clear the live handle (invariant: session ⟺ running)
    costTotal, contextTokens,   // SPEC-6-1: final cost/context on the terminal record
  });
  try {
    opts.runLog?.append(runId, {
      type: "run:ended", runId, status, endedAt,
      resultSummary: finalText.slice(0, 120), tokenTotal, costTotal, contextTokens,
      resumedFrom: opts.resumeLink, forkedFrom: opts.forkLink,
    });
  } catch { /* best-effort: journal is the index, not the product */ }
  // SPEC-4: lifecycle phase children skip the per-run todo reconciliation — the lifecycle
  // engine owns the lifecycle todo's status + progress block (Q7=C).
  if (!opts.lifecycleTodoId) {
    try {
      if (status === "completed") {
        await opts.todoSync.markRunTodoDone(todoId, priorStatus, finalText.slice(0, 500));
      } else {
        await opts.todoSync.markRunTodoReverted(todoId, priorStatus, error ?? status);
      }
    } catch {
      // swallow — the run result is authoritative; the finally in spawnSubagent releases the lock
    }
  }
  return {
    status, finalText, runId, todoId, agent: agentName, model,
    durationMs: endedAt - startedAt, tokenTotal, costTotal, contextTokens, error,
  };
}
