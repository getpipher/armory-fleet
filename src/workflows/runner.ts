// SPEC-6-3 — the workflow runner. Compiles a JS script in the vm realm, journals every
// agent()/helper()/checkpoint() call by positional call index, spawns child agents via deps.spawn,
// and returns the script's synthesized result. Resume (Task 6) + isolation/lifecycle (Task 7)
// + schema/budget (Task 8) layer on top of this core.
import { buildRealm, compileWorkflowScript, type RealmDeps } from "./vm-realm.ts";
import type { WorkflowJournal } from "./journal.ts";
import type { WorkflowProgressEvent, WorkflowRunState } from "./runtime/types.ts";
import * as helpers from "./helpers/index.ts";

/** Minimal JSON-Schema-ish validator: checks type, required, properties.<name>.type.
 *  Accepts a string (JSON.parse) or an object. Returns boolean. */
function validateResult(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return false; } }
  if (schema.type === "array" && Array.isArray(value)) return true;
  if (schema.type === "null" && value === null) return true;
  if (schema.type && typeof value !== schema.type) return false;
  if (Array.isArray(schema.required)) {
    for (const k of schema.required as string[])
      if (!Object.prototype.hasOwnProperty.call(value, k)) return false;
  }
  const props = schema.properties as Record<string, { type: string }> | undefined;
  if (props) {
    for (const [k, def] of Object.entries(props))
      if (k in (value as Record<string, unknown>) && typeof (value as Record<string, unknown>)[k] !== def.type) return false;
  }
  return true;
}

export interface WorkflowRuntimeHooks {
  signal: AbortSignal;
  waitIfPaused(): Promise<void>;
  onProgress(event: WorkflowProgressEvent): void;
}

export interface WorkflowRunDeps {
  spawn: (prompt: string, opts: { agent: string; model?: string; tier?: string; lifecycle?: string; isolation?: "worktree"; skills?: string[]; backend?: "pi" | "claude"; timeoutMs?: number; runId: string }) => Promise<{ finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number }>;
  worktree: { isGitRepo(dir?: string): boolean; create(runId: string, baseRef?: string): { path: string; branch: string }; removeWorktree(runId: string): void; remove(runId: string): void };
  tierRegistry: { get(name: string): { models: string[]; costCap?: number; contextFloor?: number } | undefined };
  journal: WorkflowJournal;
  runRegistry: { get(runId: string): { todoId?: string | null } | undefined; list(): { costTotal?: number; tokenTotal?: number; todoId?: string | null }[] };
  getModelContextWindow?: (model: string) => number | undefined;
  genRunId: () => string;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
  onCheckpoint?: (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;
  resolveWorkflow: (name: string) => { sourceText: string; executable: string } | undefined;
  maxRecursionDepth?: number;
  runLifecycle?: (task: string, name: string, opts: { mode: "auto" | "checkpointed"; worktreePath?: string }) => Promise<{ status: "completed" | "failed" | "aborted"; finalText: string; costTotal?: number; tokenTotal?: number; error?: string }>;
  runtime?: WorkflowRuntimeHooks;
}

export interface WorkflowRunOpts {
  sourceText?: string;
  script: string;
  args?: unknown;
  runId?: string;
  resumeFromRunId?: string;
  mode: "auto" | "checkpointed";
  budget?: { total: number };
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  maxRecursionDepth?: number;
}

export interface WorkflowRunResult {
  runId: string;
  status: "completed" | "failed" | "aborted";
  result?: unknown;
  error?: string;
  costTotal?: number;
  tokenTotal?: number;
  phases: { title: string; agents: number; cached: number; reRun: number }[];
  logs: string[];
  childRunIds: string[];
}

interface AgentCacheEntry { prompt: string; opts: Record<string, unknown>; result: unknown; status: string }
interface CheckpointCacheEntry { prompt: string; optsHash: string; response: unknown }

/** Run a workflow script. Resume (Task 6) is built in; isolation/lifecycle/schema land in Tasks 7-8. */
export async function runWorkflow(_ignored: string, opts: WorkflowRunOpts, deps: WorkflowRunDeps): Promise<WorkflowRunResult> {
  const runId = opts.runId ?? deps.genRunId();
  const maxAgents = opts.maxAgents ?? 1000;
  const concurrency = Math.min(opts.concurrency ?? 3, 16);
  const maxRecursion = opts.maxRecursionDepth ?? deps.maxRecursionDepth ?? 3;
  const budgetTotal = opts.budget?.total ?? Number.POSITIVE_INFINITY;

  // Resume: build the agent + checkpoint caches from the prior run's journal.
  const agentCache = new Map<number, AgentCacheEntry>();
  const checkpointCache = new Map<number, CheckpointCacheEntry>();
  if (opts.resumeFromRunId) {
    for (const e of deps.journal.replay(opts.resumeFromRunId)) {
      if (e.type === "agent:call") agentCache.set(e.callIndex, { prompt: e.prompt, opts: e.opts, result: undefined as unknown, status: "pending" });
      else if (e.type === "agent:result") {
        const c = agentCache.get(e.callIndex);
        if (c) { c.result = e.result; c.status = e.status; }
      } else if (e.type === "helper:call" && (e as { name: string }).name === "checkpoint") {
        // Build checkpoint cache from helper:call (has prompt + opts in args) — the checkpoint
        // event (added later) fills in the response.
        const args = e.args as [string, Record<string, unknown>];
        checkpointCache.set(e.callIndex, { prompt: args[0] ?? "", optsHash: JSON.stringify(args[1] ?? {}), response: undefined as unknown });
      } else if (e.type === "checkpoint") {
        const c = checkpointCache.get(e.callIndex);
        if (c) c.response = e.response;
      }
    }
  }

  let callIndex = 0;
  const phaseCounts = new Map<string, { agents: number; cached: number; reRun: number }>();
  let currentPhase = "default";
  let agentCount = 0;
  let spent = 0;
  const logs: string[] = [];
  const childRunIds: string[] = [];
  let costAccum = 0;
  const startedAt = Date.now();
  let terminalWritten = false;

  const nextCallIndex = () => callIndex++;

  const safeSerialize = (value: unknown): string => {
    try { return JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
  };

  const emitProgress = (kind: WorkflowProgressEvent["kind"]): void => {
    const phasesSnapshot = [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c }));
    const status = kind === "completed" ? "completed" : kind === "aborted" ? "aborted" : kind === "failed" ? "failed" : "running";
    const snapshot: WorkflowRunState = {
      runId,
      name: _ignored,
      script: opts.sourceText ?? opts.script,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      mode: opts.mode,
      status: status as WorkflowRunState["status"],
      startedAt,
      currentPhase,
      phases: phasesSnapshot,
      childRunIds: [...childRunIds],
      logs: [...logs],
      tokenTotal: spent,
      costTotal: costAccum,
    };
    if (deps.runtime) deps.runtime.onProgress({ kind, runId, snapshot });
    deps.journal.append(runId, {
      type: "wf:progress",
      kind,
      runId,
      status,
      currentPhase,
      phases: phasesSnapshot,
      childRunIds: [...childRunIds],
      logs: [...logs],
      tokenTotal: spent,
      costTotal: costAccum,
      ts: Date.now(),
    });
  };

  const beforeDispatch = async (): Promise<void> => {
    await deps.runtime?.waitIfPaused();
    if (deps.runtime?.signal.aborted) {
      throw deps.runtime.signal.reason instanceof Error
        ? deps.runtime.signal.reason
        : new Error("workflow stopped");
    }
  };

  const log = (message: unknown): void => {
    const line = (typeof message === "string" ? message : safeSerialize(message)).slice(0, 500);
    logs.push(line);
    if (logs.length > 100) logs.shift();
    emitProgress("log");
  };

  type TrackedSpawnOpts = {
    agent: string;
    model?: string;
    tier?: string;
    skills?: string[];
    backend?: "pi" | "claude";
    isolation?: "worktree";
    retries?: number;
    timeoutMs?: number;
    runId: string;
  };

  const trackedSpawn = async (prompt: string, spawnOpts: TrackedSpawnOpts): Promise<{ finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number }> => {
    await beforeDispatch();
    if (spent >= budgetTotal) throw new Error("token budget exceeded");
    const effectiveTimeout = spawnOpts.timeoutMs ?? opts.agentTimeoutMs;
    let result: { finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number };
    if (effectiveTimeout && effectiveTimeout > 0) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      try {
        result = await Promise.race([
          deps.spawn(prompt, spawnOpts),
          new Promise<never>((_, reject) => {
            timeoutSignal.addEventListener("abort", () => reject(new Error(`agent timed out after ${effectiveTimeout}ms`)), { once: true });
          }),
        ]);
      } catch (e) {
        // A workflow abort wins over a spawn timeout.
        if (deps.runtime?.signal.aborted) {
          throw deps.runtime.signal.reason instanceof Error ? deps.runtime.signal.reason : new Error("workflow stopped");
        }
        // Treat a timeout as a retryable failed spawn.
        result = { finalText: "", runId: spawnOpts.runId, status: "failed" };
      }
    } else {
      result = await deps.spawn(prompt, spawnOpts);
    }
    childRunIds.push(result.runId);
    spent += result.tokenTotal ?? 0;
    costAccum += result.costTotal ?? 0;
    emitProgress(result.status === "completed" ? "child-completed" : "child-failed");
    return result;
  };
  const phaseOf = (title: string, _opts?: { budget?: number }): void => {
    currentPhase = title;
    if (!phaseCounts.has(title)) phaseCounts.set(title, { agents: 0, cached: 0, reRun: 0 });
    emitProgress("phase");
  };

  // The agent() global — spawns a child, journals call+result by index. On resume, reuses
  // cached result when prompt + opts match the prior run's call at the same index.
  const agent = async (prompt: string, callOpts: Record<string, unknown> = {}): Promise<unknown> => {
    if (agentCount >= maxAgents) throw new Error(`max agents (${maxAgents}) exceeded`);
    const remaining = budgetTotal - spent;
    if (remaining <= 0) throw new Error("token budget exceeded");
    const idx = nextCallIndex();
    const label = (callOpts.label as string) ?? `agent ${idx}`;
    const phase = (callOpts.phase as string) ?? currentPhase;
    deps.journal.append(runId, { type: "agent:call", callIndex: idx, label, phase, prompt, opts: callOpts, ts: Date.now() });
    const pc = phaseCounts.get(phase) ?? { agents: 0, cached: 0, reRun: 0 };
    pc.agents++;

    // Resume: reuse cached result when prompt + opts match the prior run at this index.
    const cached = agentCache.get(idx);
    if (cached && cached.status !== "pending" && cached.prompt === prompt && JSON.stringify(cached.opts) === JSON.stringify(callOpts)) {
      pc.cached++;
      phaseCounts.set(phase, pc);
      deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: "(cached)", result: cached.result, status: cached.status as "completed" | "failed", ts: Date.now() });
      return cached.result;
    }

    pc.reRun++;
    phaseCounts.set(phase, pc);
    agentCount++;

    // Lifecycle bridge (the moat) — runs a full superpowers lifecycle as this one step.
    // Ordered FIRST so agent({lifecycle, isolation:'worktree'}) runs the lifecycle in the worktree.
    if (callOpts.lifecycle) {
      if (!deps.runLifecycle) throw new Error("lifecycle bridge not configured");
      await beforeDispatch();
      const lcName = callOpts.lifecycle as string;
      let worktreePath: string | undefined;
      let wtRunId: string | undefined;
      if (callOpts.isolation === "worktree") {
        if (!deps.worktree.isGitRepo()) {
          // Deterministic env error → null (not retryable). Journal result for completeness.
          deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: "(fail-fast)", result: null, status: "failed", ts: Date.now() });
          return null;
        }
        wtRunId = deps.genRunId();
        worktreePath = deps.worktree.create(wtRunId).path;
      }
      try {
        const lcRes = await deps.runLifecycle(prompt, lcName, { mode: opts.mode, ...(worktreePath ? { worktreePath } : {}) });
        spent += lcRes.tokenTotal ?? 0;
        costAccum += lcRes.costTotal ?? 0;
        if (wtRunId) childRunIds.push(wtRunId);
        emitProgress(lcRes.status === "completed" ? "child-completed" : "child-failed");
        deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: wtRunId ?? "(lifecycle)", result: lcRes.status === "completed" ? lcRes.finalText : null, status: lcRes.status === "completed" ? "completed" : "failed", ...(lcRes.costTotal != null ? { costTotal: lcRes.costTotal } : {}), ...(lcRes.tokenTotal != null ? { tokenTotal: lcRes.tokenTotal } : {}), ts: Date.now() });
        return lcRes.status === "completed" ? lcRes.finalText : null;
      } finally { if (wtRunId) deps.worktree.removeWorktree(wtRunId); }
    }

    // Isolation: 'worktree' (no lifecycle) — v0.11.1 seam fail-fast.
    if (callOpts.isolation === "worktree") {
      if (!deps.worktree.isGitRepo()) {
        // Deterministic env error → null (not retryable). Journal result for completeness.
        deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: "(fail-fast)", result: null, status: "failed", ts: Date.now() });
        return null;
      }
      const wtRunId = deps.genRunId();
      deps.worktree.create(wtRunId);
      try {
        const res = await trackedSpawn(prompt, { agent: (callOpts.agentType as string) ?? "general-purpose", ...(callOpts.model ? { model: callOpts.model as string } : {}), ...(callOpts.tier ? { tier: callOpts.tier as string } : {}), ...(callOpts.timeoutMs ? { timeoutMs: callOpts.timeoutMs as number } : {}), isolation: "worktree", runId: wtRunId });
        deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: res.runId, result: res.status === "completed" ? res.finalText : null, status: res.status, ...(res.costTotal != null ? { costTotal: res.costTotal } : {}), ts: Date.now() });
        return res.status === "completed" ? res.finalText : null;
      } finally { deps.worktree.removeWorktree(wtRunId); }
    }

    // Default in-place spawn (with optional schema validation via retries).
    // Schema is ignored when lifecycle or isolation is set (those branches return above).
    const maxRetries = (callOpts.retries as number | undefined) ?? opts.agentRetries ?? 0;
    let attempt = 0;
    let res: { finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number };
    let resultValue: unknown;
    do {
      res = await trackedSpawn(prompt, {
        agent: (callOpts.agentType as string) ?? "general-purpose",
        ...(callOpts.model ? { model: callOpts.model as string } : {}),
        ...(callOpts.tier ? { tier: callOpts.tier as string } : {}),
        ...(callOpts.skills ? { skills: Array.from(callOpts.skills as unknown[]) as string[] } : {}),
        ...(callOpts.backend ? { backend: callOpts.backend as "pi" | "claude" } : {}),
        ...(callOpts.timeoutMs ? { timeoutMs: callOpts.timeoutMs as number } : {}),
        runId,
      });
      resultValue = res.status === "completed" ? res.finalText : null;
      // Retry on failed spawn status when retries remain.
      if (res.status !== "completed" && attempt < maxRetries) {
        attempt++;
        if (deps.runtime?.signal.aborted) break;
        continue;
      }
      // Schema validation: if set + result non-null + mismatch -> re-spawn (one repair per retry).
      if (callOpts.schema && resultValue != null && !validateResult(resultValue, callOpts.schema as Record<string, unknown>)) {
        attempt++;
        resultValue = null;
        if (deps.runtime?.signal.aborted) break;
        continue;
      }
      break;
    } while (attempt <= maxRetries);
    // Parse JSON ONLY when schema is present; non-schema agent returns the raw string.
    if (callOpts.schema && resultValue != null && typeof resultValue === "string") {
      try { resultValue = JSON.parse(resultValue); } catch { /* leave as string if not JSON */ }
    }
    if (!callOpts.schema && res.status !== "completed") resultValue = null;
    deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: res.runId, result: resultValue, status: res.status, ...(res.costTotal != null ? { costTotal: res.costTotal } : {}), ...(res.tokenTotal != null ? { tokenTotal: res.tokenTotal } : {}), ts: Date.now() });
    return resultValue;
  };

  // parallel() — concurrency-clamped, order-preserving.
  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    const results: unknown[] = new Array(thunks.length);
    let next = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= thunks.length) break;
        results[i] = await thunks[i]!();
      }
    })());
    await Promise.all(workers);
    return results;
  };

  // pipeline() — fan items through sequential stages.
  const pipeline = async (items: unknown[], ...stages: Array<(item: unknown) => Promise<unknown>>): Promise<unknown[]> => {
    let cur = items;
    for (const stage of stages) cur = await Promise.all(cur.map((i) => stage(i)));
    return cur;
  };

  // workflow() — run a saved workflow as a child. Recursion cap: throw if depth exhausted.
  const workflow = async (name: string, childArgs?: unknown): Promise<unknown> => {
    await beforeDispatch();
    const resolved = deps.resolveWorkflow(name);
    if (!resolved) throw new Error(`workflow '${name}' not found`);
    if (maxRecursion - 1 < 0) throw new Error("workflow recursion depth exceeded");
    emitProgress("child-started");
    const childResult = await runWorkflow("child", {
      script: resolved.executable,
      sourceText: resolved.sourceText,
      args: childArgs,
      mode: opts.mode,
      runId: deps.genRunId(),
      budget: { total: budgetTotal - spent },
      maxAgents: maxAgents - agentCount,
      maxRecursionDepth: maxRecursion - 1,
    }, deps);
    if (childResult.status === "aborted") throw new Error(`child workflow '${name}' aborted: ${childResult.error ?? "unknown"}`);
    for (const id of childResult.childRunIds) childRunIds.push(id);
    spent += childResult.tokenTotal ?? 0;
    costAccum += childResult.costTotal ?? 0;
    return childResult.result;
  };

  // The HelperCtx shared by all 7 helpers.
  const helperCtx: helpers.HelperCtx = {
    spawn: async (prompt, hOpts) => {
      const maxRetries = hOpts?.retries ?? 0;
      let attempt = 0;
      const buildOpts = () => ({
        agent: hOpts?.agent ?? "reviewer",
        ...(hOpts?.model ? { model: hOpts.model } : {}),
        ...(hOpts?.tier ? { tier: hOpts.tier } : {}),
        ...(hOpts?.skills ? { skills: hOpts.skills } : {}),
        ...(hOpts?.backend ? { backend: hOpts.backend } : {}),
        ...(hOpts?.timeoutMs ? { timeoutMs: hOpts.timeoutMs } : {}),
        runId,
      });
      let res = await trackedSpawn(prompt, buildOpts());
      while (res.status !== "completed" && attempt < maxRetries) {
        if (deps.runtime?.signal.aborted) break;
        attempt++;
        res = await trackedSpawn(prompt, buildOpts());
      }
      return res as unknown as helpers.HelperSpawnResult;
    },
    journal: deps.journal,
    runId,
    ...(opts.budget ? { budget: { spent: () => spent, remaining: () => budgetTotal - spent } } : {}),
    ...(deps.onCheckpoint ? { onCheckpoint: deps.onCheckpoint } : {}),
    ...(deps.getModelContextWindow ? { getModelContextWindow: deps.getModelContextWindow } : {}),
    nextCallIndex,
  };

  // Wrap each helper to journal helper:call (with callIndex + name + args) before calling,
  // and helper:result after. The nextCallIndex fn is shared with agent() so the positional
  // index is monotonic across all call types.
  const wrapHelper = <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const idx = nextCallIndex();
      deps.journal.append(runId, { type: "helper:call", callIndex: idx, name, args, ts: Date.now() });
      emitProgress("helper-started");
      const result = await fn(...args);
      deps.journal.append(runId, { type: "helper:result", callIndex: idx, name, result, ts: Date.now() });
      emitProgress("helper-completed");
      return result;
    };
  };

  // Checkpoint is special-cased: it checks the resume cache BEFORE calling onCheckpoint/headless.
  // The cache key is callIndex + prompt + JSON.stringify(opts). On resume, if the prior run's
  // checkpoint at the same index has the same prompt + opts, reuse the response (no re-prompt).
  const wrappedCheckpoint = async (prompt: string, cpOpts: Record<string, unknown> = {}): Promise<unknown> => {
    await beforeDispatch();
    const idx = nextCallIndex();
    const optsHash = JSON.stringify(cpOpts);
    deps.journal.append(runId, { type: "helper:call", callIndex: idx, name: "checkpoint", args: [prompt, cpOpts], ts: Date.now() });
    emitProgress("checkpoint");

    // Resume: check checkpoint cache before prompting. Cache key: callIndex + prompt + optsHash.
    const cachedCp = checkpointCache.get(idx);
    if (cachedCp && cachedCp.prompt === prompt && cachedCp.optsHash === optsHash) {
      deps.journal.append(runId, { type: "helper:result", callIndex: idx, name: "checkpoint", result: cachedCp.response, ts: Date.now() });
      deps.journal.append(runId, { type: "checkpoint", callIndex: idx, prompt, response: cachedCp.response, ts: Date.now() });
      emitProgress("checkpoint-resolved");
      return cachedCp.response;
    }

    const result = await helpers.checkpoint(prompt, cpOpts as never, helperCtx);
    deps.journal.append(runId, { type: "helper:result", callIndex: idx, name: "checkpoint", result, ts: Date.now() });
    deps.journal.append(runId, { type: "checkpoint", callIndex: idx, prompt, response: result, ts: Date.now() });
    emitProgress("checkpoint-resolved");
    return result;
  };

  const wrappedHelpers: RealmDeps = {
    agent, parallel, pipeline, phase: phaseOf, workflow,
    verify: wrapHelper("verify", (item: unknown, o?: Record<string, unknown>) => helpers.verify(item, (o ?? {}) as never, helperCtx)),
    judgePanel: wrapHelper("judgePanel", (a: unknown[], o?: Record<string, unknown>) => helpers.judgePanel(a, (o ?? {}) as never, helperCtx)),
    loopUntilDry: wrapHelper("loopUntilDry", (o: Record<string, unknown>) => helpers.loopUntilDry(o as never, helperCtx)),
    completenessCheck: wrapHelper("completenessCheck", (t: unknown, r: unknown, o?: Record<string, unknown>) => helpers.completenessCheck(t, r, helperCtx, o as never)),
    gate: wrapHelper("gate", (t: (fb: string | undefined, n: number) => unknown, v: (val: unknown) => { ok: boolean; feedback?: string }, o?: Record<string, unknown>) => helpers.gate(t as never, v as never, (o ?? {}) as never, helperCtx) as Promise<unknown>),
    retry: wrapHelper("retry", (t: (n: number) => unknown, o?: Record<string, unknown>) => helpers.retry(t as never, (o ?? {}) as never, helperCtx)),
    checkpoint: wrappedCheckpoint,
    log,
    args: opts.args,
    cwd: process.cwd(),
    budget: { total: budgetTotal, spent: () => spent, remaining: () => budgetTotal - spent },
  };

  const realm = buildRealm(wrappedHelpers);
  deps.journal.append(runId, { type: "wf:started", runId, script: opts.sourceText ?? opts.script, args: opts.args, phases: [], mode: opts.mode, ts: Date.now() });
  emitProgress("started");

  try {
    const script = compileWorkflowScript(opts.script);
    const result = await script.runInContext(realm);
    // Abort-wins guard: if signal aborted during execution, write wf:aborted (not wf:completed).
    if (deps.runtime?.signal.aborted && !terminalWritten) {
      terminalWritten = true;
      const reason = deps.runtime.signal.reason instanceof Error
        ? deps.runtime.signal.reason.message
        : "workflow stopped";
      emitProgress("aborted");
      deps.journal.append(runId, { type: "wf:aborted", runId, reason, ts: Date.now() });
      return { runId, status: "aborted", error: reason, logs, childRunIds, phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
    }
    if (!terminalWritten) {
      terminalWritten = true;
      emitProgress("completed");
      deps.journal.append(runId, { type: "wf:completed", runId, result, ...(costAccum ? { costTotal: costAccum } : {}), ...(spent ? { tokenTotal: spent } : {}), ts: Date.now() });
    }
    return { runId, status: "completed", result, ...(costAccum ? { costTotal: costAccum } : {}), ...(spent ? { tokenTotal: spent } : {}), logs, childRunIds, phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
  } catch (e) {
    if (!terminalWritten) {
      terminalWritten = true;
      const reason = (e as Error).message;
      emitProgress("aborted");
      deps.journal.append(runId, { type: "wf:aborted", runId, reason, ts: Date.now() });
      return { runId, status: "aborted", error: reason, logs, childRunIds, phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
    }
    return { runId, status: "aborted", error: (e as Error).message, logs, childRunIds, phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
  }
}
