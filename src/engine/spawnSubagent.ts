// src/engine/spawnSubagent.ts
import type { AgentDef, ThinkingLevel } from "../registry/frontmatter.ts";
import type { FleetRunStatus, TodoSyncPort } from "../todo-sync/port.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";
import type { VisionPort } from "../vision/port.ts";
import type { BackendRegistry } from "../backend/port.ts";
import { genRunId, RunRegistry } from "./run-registry.ts";
import { createTurnBudget, DEFAULT_MAX_TURNS } from "./turn-budget.ts";
import type { SingleSlotLock } from "./concurrency-lock.ts";

const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

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
    usage?: { cost?: { total?: number } };
  };
  /** Emitted by a backend on session init (SPEC-3). Drives runRecord.backendSessionId. */
  backendSessionId?: string;
}

export interface ChildSession {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: ChildSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
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
    const backend = opts.backendRegistry.get(agentDef.backend);
    if (!backend || !backend.available()) {
      const note = backend?.versionInfo()?.note ?? "not registered";
      return fail(runId, startedAt, `backend '${agentDef.backend}' unavailable: ${note}`, opts.agent);
    }

    // resolve model
    const model = opts.model ?? agentDef.model ?? `${opts.parentModel.provider}/${opts.parentModel.id}`;

    // child tools pass through UNFILTERED — the single-writer `todo`-exclusion is enforced
    // downstream by the child factory's `excludeTools: ["todo"]` (SPEC-2 §9.1 hardening).
    const tools = agentDef.tools ?? PI_DEFAULT_TOOLS;
    const memoryPort = opts.memoryPort ?? NOOP_MEMORY_PORT;
    const visionPort = opts.visionPort ?? NOOP_VISION_PORT;

    // run record
    opts.runRegistry.add({
      runId, agent: agentDef.name, model, task: opts.task, track,
      todoId: null, status: "running", startedAt,
    });

    // todo-sync (before) — only when both caller tracks AND agent allows todoSync
    let priorStatus: string | undefined;
    let todoId: string | null = null;
    try {
      const link = await opts.todoSync.linkOrCreateRunTodo({
        runId, agent: agentDef.name, task: opts.task,
        todoId: opts.todoId, track: track && agentDef.todoSync,
      });
      todoId = link.todoId;
      priorStatus = link.priorStatus;
      opts.runRegistry.update(runId, { todoId });
    } catch (e) {
      return await finishRun(opts, runId, startedAt, "failed", "", todoId, priorStatus, (e as Error).message, agentDef.name, model);
    }

    // spawn child
    const { session } = await backend.factory.create({
      cwd: opts.parentCwd,
      model,
      thinkingLevel: agentDef.thinkingLevel,
      tools,
      rolePrompt: agentDef.rolePrompt,
      skills: agentDef.skills ?? [],
      task: opts.task,
      agent: agentDef,
      memoryPort,
      visionPort,
    });

    const budget = createTurnBudget(maxTurns);
    let finalText = "";
    let tokenTotal = 0;
    let aborted = false;

    const onSignalAbort = (): void => { aborted = true; void session.abort(); };
    opts.signal?.addEventListener("abort", onSignalAbort);

    const unsub = session.subscribe((e) => {
      if (e.type === "session_init" && e.backendSessionId) {
        opts.runRegistry.update(runId, { backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey });
      } else if (e.type === "turn_end") {
        if (budget.consume()) void session.abort();
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = e.message.content?.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        if (text) finalText = text;
        const total = e.message.usage?.cost?.total;
        if (typeof total === "number") tokenTotal += total;
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
      error = "aborted by user";
    } else if (budget.count() >= maxTurns) {
      status = "failed";
      error = `hit turn budget (${maxTurns}) mid-task; partial result: ${finalText.slice(0, 200)}`;
    } else if (runError) {
      status = "failed";
      error = runError;
    } else {
      status = "completed";
    }

    return await finishRun(opts, runId, startedAt, status, finalText, todoId, priorStatus, error, agentDef.name, model, tokenTotal);
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

async function finishRun(
  opts: SpawnOptions, runId: string, startedAt: number,
  status: FleetRunStatus, finalText: string, todoId: string | null, priorStatus: string | undefined,
  error: string | undefined, agentName: string, model: string, tokenTotal = 0,
): Promise<SpawnResult> {
  const endedAt = Date.now();
  opts.runRegistry.update(runId, { status, endedAt, resultSummary: finalText.slice(0, 120) });
  // todo-sync reconciliation must not mask the run result
  try {
    if (status === "completed") {
      await opts.todoSync.markRunTodoDone(todoId, priorStatus, finalText.slice(0, 500));
    } else {
      await opts.todoSync.markRunTodoReverted(todoId, priorStatus, error ?? status);
    }
  } catch {
    // swallow — the run result is authoritative; the finally in spawnSubagent releases the lock
  }
  return {
    status, finalText, runId, todoId, agent: agentName, model,
    durationMs: endedAt - startedAt, tokenTotal, error,
  };
}