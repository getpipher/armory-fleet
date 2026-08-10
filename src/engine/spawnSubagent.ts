// src/engine/spawnSubagent.ts
import type { AgentDef, ThinkingLevel } from "../registry/frontmatter.ts";
import type { FleetRunStatus, TodoSyncPort } from "../todo-sync/port.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";
import type { VisionPort } from "../vision/port.ts";
import type { BackendRegistry } from "../backend/port.ts";
import { genRunId, RunRegistry } from "./run-registry.ts";
import type { RunRecord } from "./run-registry.ts";
import { createTurnBudget, DEFAULT_MAX_TURNS } from "./turn-budget.ts";
import type { ForegroundLock } from "./concurrency-lock.ts";
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
  lock: ForegroundLock;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory — engine looks up by agentDef.backend
  parentModel: { provider: string; id: string };
  parentCwd: string;
  /** SPEC-6-5: the dispatch target's working directory. Default = parentCwd (the session cwd, backward-compat).
   *  When set, all child-scoped sites use this cwd (factory.create, RunRecord.cwd, run:meta cwd);
   *  session-scoped audit (`sessionCwd`) keeps parentCwd. */
  cwd?: string;
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
  /** #31: when true, the caller asserts this dispatch will NOT mutate the working directory
   *  (review/audit/research). Read-only dispatches bypass the foreground single-slot lock so
   *  multiple readOnly dispatches — and/or a readOnly dispatch alongside a write dispatch — can
   *  run in parallel. Mislabeling a write dispatch as readOnly risks in-place edit conflicts. */
  readOnly?: boolean;
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
  /** #39: true when the failure is a retryable provider rate-limit / auth failure
   *  (stopReason "error"). The subagent tool retries once with the configured `modelFallback`
   *  when this is set. Non-retryable failures (turn budget, agent-not-found, EMPTY_RESULT,
   *  abort, lock busy) leave this unset. */
  retryable?: boolean;
  /** #49: file paths the child mutated before the run ended (edit/write `path`; bash
   *  redirections/tee best-effort), deduped + sorted. Lets the controller re-inspect only
   *  what changed after a turn-budget cut, instead of the whole repo. Populated on every
   *  run (completed runs too); most useful on the turn-budget branch. */
  filesTouched?: string[];
  /** #49: did the child emit a trailing assistant message after its last tool (a summary),
   *  or was it cut mid-tool-work? Surfaced on turn-budget exhaustion so the controller knows
   *  whether finalText is a partial summary or a mid-thought. Undefined for non-turn-budget paths. */
  reachedSummary?: boolean;
}

/** #49: extract file paths a tool event touched, for the structured partial-result report.
 *  edit/write carry a `path` arg reliably; bash is best-effort (redirections `>`/`>>` + `tee` to a
 *  path-like token). Reads are NOT mutations and are excluded. */
function extractTouchedFiles(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  if (toolName === "edit" || toolName === "write") {
    const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
    return p ? [p] : [];
  }
  if (toolName === "bash") {
    const cmd = typeof a.command === "string" ? a.command : undefined;
    if (!cmd) return [];
    const out: string[] = [];
    // `> path` / `>> path` / `tee path` — only tokens that look like a path (contain `/` or `.`)
    // to avoid false positives on bare words ("echo done", "exit 0").
    const redir = />>?\s+([^\s|;&<>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = redir.exec(cmd)) !== null) {
      const tok = m[1];
      if (tok && /[/.]/.test(tok)) out.push(tok);
    }
    const tee = /\btee\s+(?:-a\s+)?([^\s|;&<>]+)/g;
    while ((m = tee.exec(cmd)) !== null) {
      const tok = m[1];
      if (tok && /[/.]/.test(tok)) out.push(tok);
    }
    return out;
  }
  return [];
}

export async function spawnSubagent(opts: SpawnOptions): Promise<SpawnResult> {
  const track = opts.track ?? true;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();
  const childCwd = opts.cwd ?? opts.parentCwd;

  // #31: read-only dispatches (review/audit/research) bypass the foreground single-slot lock —
  // the caller asserts no cwd mutation, so the in-place edit-conflict guard doesn't apply and
  // multiple readOnly dispatches (and/or a readOnly alongside a write dispatch) may run in
  // parallel. The lock is still acquired for write dispatches (default), preserving concurrency=1.
  const readOnly = opts.readOnly ?? false;
  let runId: string;
  if (readOnly) {
    runId = genRunId();
  } else {
    // #31 tail: foreground concurrency lock. cap=1 (default) is FAIL-FAST (backward-compat — a
    // 2nd dispatch is rejected with the held runId + the cap + the env hint); cap>1 (opt-in via
    // ARMORY_FLEET_FOREGROUND_CONCURRENCY) QUEUES — up to `cap` writes run in parallel, the rest wait.
    // The cap is session-level (a shared lock can't be re-sized per dispatch); see concurrency-lock.ts.
    runId = genRunId();
    const acq = await opts.lock.acquire(runId);
    if (!acq.ok) {
      const hint = opts.lock.cap === 1
        ? ` (foreground concurrency=1; ${acq.busy.join(", ")} is running — wait for it to finish or abort it, or raise ARMORY_FLEET_FOREGROUND_CONCURRENCY to allow parallel write dispatches)`
        : ` (foreground concurrency=${opts.lock.cap}; all ${opts.lock.cap} slots held by ${acq.busy.join(", ")}); wait for one to finish or raise ARMORY_FLEET_FOREGROUND_CONCURRENCY)`;
      return fail("", startedAt, `a subagent is already running${hint}`, opts.agent);
    }
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
      cwd: childCwd, sessionCwd: opts.parentCwd, backend: backendId,
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
          cwd: childCwd,
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
    opts.runRegistry.update(runId, { session: handle, turnMax: maxTurns });

    const budget = createTurnBudget(maxTurns);
    let finalText = "";
    let tokenTotal = 0;
    let costTotal = 0;
    let contextTokens = 0;
    let turnIdx = -1;
    // #32: substrate baseline — the turn-1 context-token snapshot (armory substrate overhead).
    // Captured once on the first assistant message_end (turnIdx === 0); threaded to the RunRecord
    // so the widget can classify the tok/ctx% segment as "substrate" (flat) vs "work" (growing).
    let substrateBaseline: number | undefined;
    // #26/#22: declared before subscribe() because some child sessions emit events
    // synchronously inside subscribe() (temporal-dead-zone guard).
    let modelError: string | undefined;   // model-call failure surfaced via stopReason "error"
    let sawAssistantMessage = false;      // #22: did the child emit any assistant message_end at all?
    // #49: structured partial-result tracking — what the child mutated, and whether it emitted
    // a trailing assistant message after its last tool (a summary) vs being cut mid-tool-work.
    const filesTouched = new Set<string>();
    let sawAssistantAfterLastTool = true;   // no tools yet = trivially "reached a summary"

    // #23: liveness — classify events into a short, content-free class string for the widget.
    // Names the tool (safe — tool name is not args/result) so the operator sees "what's happening"
    // without leaking prompt content, secrets, or full tool arguments/results (per #23 acceptance).
    const classifyEvent = (e: ChildSessionEvent): string => {
      if (e.type === "turn_start") return "turn";
      if (e.type === "turn_end") return "turn_end";
      if (e.type === "message_end") return e.message?.role === "assistant" ? "assistant" : (e.message?.role ?? "message");
      if (e.type === "tool_execution_end") return `tool:${(e as { toolName?: string }).toolName ?? "?"}`;
      if (e.type === "session_init") return "init";
      return e.type;
    };

    const onSignalAbort = (): void => { aborted = true; void session.abort(); };
    opts.signal?.addEventListener("abort", onSignalAbort);

    const unsub = session.subscribe((e) => {
      if (e.type === "session_init" && e.backendSessionId) {
        opts.runRegistry.update(runId, { backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey });
        try {
          opts.runLog?.append(runId, { type: "run:meta", runId, agent: agentDef.name, model, task: opts.task, startedAt, track, todoId, backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey, cwd: childCwd, sessionCwd: opts.parentCwd, pid: (session as { proc?: { pid?: number } }).proc?.pid });
        } catch { /* best-effort */ }
      } else if (e.type === "turn_start") {
        turnIdx++;
      } else if (e.type === "turn_end") {
        if (budget.consume()) void session.abort();
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        sawAssistantMessage = true;
        sawAssistantAfterLastTool = true;   // #49: a trailing assistant message = (so far) reached a summary
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
        // #32: capture the substrate baseline at the end of turn 1 (the first assistant
        // message_end). The turn-1 context is dominated by the armory substrate (system prompt +
        // skills + memory); subsequent turns barely grow it unless real work adds tool results.
        const patch: Partial<RunRecord> = { costTotal, contextTokens, tokenTotal };
        if (substrateBaseline === undefined && turnIdx === 0 && contextTokens > 0) {
          substrateBaseline = contextTokens;
          patch.substrateBaseline = substrateBaseline;
        }
        opts.runRegistry.update(runId, patch);
        try {
          opts.runLog?.append(runId, { type: "message", role: "assistant", text, usage: { total: turnTokens, input: u?.input, output: u?.output, cacheRead: u?.cacheRead, cacheWrite: u?.cacheWrite, cost: u?.cost }, turnIndex: turnIdx });
        } catch { /* best-effort */ }
        // SPEC-6-1: cap abort — if costTotal exceeds tier.costCap, abort + flag budget_exceeded.
        if (tier?.costCap && costTotal > tier.costCap) {
          aborted = true;
          void session.abort();
        }
      } else if (e.type === "tool_execution_end") {
        // #49: track mutated files for the structured partial-result report.
        sawAssistantAfterLastTool = false;   // cut mid-tool-work unless a message follows
        for (const f of extractTouchedFiles((e as { toolName?: string }).toolName ?? "", (e as { args?: unknown }).args)) filesTouched.add(f);
        try {
          opts.runLog?.append(runId, buildToolEvent((e as any).toolName, (e as any).args, (e as any).result, (e as any).isError ?? false, turnIdx));
        } catch { /* best-effort */ }
      }
      // #23: liveness heartbeat — update the run record on meaningful events so the fleet widget
      // can show turn count + last-event class + "events still arriving" without leaking content.
      if (e.type === "turn_start" || e.type === "message_end" || e.type === "tool_execution_end") {
        opts.runRegistry.update(runId, {
          turnCount: Math.max(0, turnIdx + 1),
          lastEventClass: classifyEvent(e),
          lastEventAt: Date.now(),
        });
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
    const filesTouchedList = [...filesTouched].sort();   // #49: deduped + sorted
    let reachedSummary: boolean | undefined;            // #49: only set on the turn-budget branch
    if (aborted) {
      status = "aborted";
      // #23: distinguish TODO-status reversion from filesystem rollback. A foreground run is in-place
      // (no worktree isolation — that's a background-run concern), so an abort reverts the linked TODO
      // to open (retryable) but leaves any partial file edits in the working dir for inspection.
      const rollbackNote = " — TODO reverted to open (retryable); in-place file changes NOT rolled back (inspect the working dir for partial work)";
      error = tier?.costCap && costTotal > tier.costCap
        ? `budget_exceeded (cost $${costTotal.toFixed(4)} > cap $${tier.costCap})${rollbackNote}`
        : `aborted by user${rollbackNote}`;
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
      // #49: surface WHAT was modified + whether the partial is a summary or a mid-thought, so the
      // controller can re-inspect only the touched files instead of the whole repo, and knows
      // whether to trust finalText as a partial summary.
      reachedSummary = sawAssistantAfterLastTool;
      const filesLine = filesTouchedList.length
        ? `\n\nFiles modified before the cut: ${filesTouchedList.join(", ")}`
        : "\n\nFiles modified before the cut: (none detected)";
      error = `hit turn budget (${maxTurns}) mid-task; partial result:\n${partial}${filesLine}\nReached summary: ${reachedSummary ? "yes" : "no (cut mid-tool-work)"}`;
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

    return await finishRun(opts, runId, startedAt, status, finalText, todoId, priorStatus, error, agentDef.name, model, tokenTotal, costTotal, contextTokens, modelError ? true : undefined, filesTouchedList, reachedSummary);
  } finally {
    // #31: a readOnly dispatch never acquired the lock — don't release what it didn't take
    // (releasing a lock held by another concurrent write dispatch would corrupt serialization).
    if (!readOnly) opts.lock.release(runId);
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
  retryable?: boolean,
  filesTouched?: string[], reachedSummary?: boolean,
): Promise<SpawnResult> {
  if (finalizedRunIds.has(runId)) {
    // Already finalized — return the existing registry record's result without re-appending.
    const existing = opts.runRegistry.get(runId);
    return {
      status: existing?.status ?? status, finalText: existing?.resultSummary ?? finalText,
      runId, todoId, agent: agentName, model,
      durationMs: existing?.endedAt ? existing.endedAt - startedAt : Date.now() - startedAt,
      tokenTotal, costTotal, contextTokens, error, retryable,
      filesTouched, reachedSummary,
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
    durationMs: endedAt - startedAt, tokenTotal, costTotal, contextTokens, error, retryable,
    filesTouched, reachedSummary,
  };
}
