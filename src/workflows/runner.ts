// SPEC-6-3 — the workflow runner. Compiles a JS script in the vm realm, journals every
// agent()/helper()/checkpoint() call by positional call index, spawns child agents via deps.spawn,
// and returns the script's synthesized result. Resume (Task 6) + isolation/lifecycle (Task 7)
// + schema/budget (Task 8) layer on top of this core.
import vm from "node:vm";
import { buildRealm, compileWorkflowScript, type RealmDeps } from "./vm-realm.ts";
import type { WorkflowJournal, WorkflowJournalEvent } from "./journal.ts";
import * as helpers from "./helpers/index.ts";

export interface WorkflowRunDeps {
  spawn: (prompt: string, opts: { agent: string; model?: string; tier?: string; lifecycle?: string; isolation?: "worktree"; skills?: string[]; backend?: "pi" | "claude"; runId: string }) => Promise<{ finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number }>;
  worktree: { isGitRepo(dir?: string): boolean; create(runId: string, baseRef?: string): { path: string; branch: string }; removeWorktree(runId: string): void; remove(runId: string): void };
  tierRegistry: { get(name: string): { models: string[]; costCap?: number; contextFloor?: number } | undefined };
  journal: WorkflowJournal;
  runRegistry: { get(runId: string): { todoId?: string | null } | undefined; list(): { costTotal?: number; tokenTotal?: number; todoId?: string | null }[] };
  getModelContextWindow?: (model: string) => number | undefined;
  genRunId: () => string;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
  onCheckpoint?: (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;
  resolveWorkflow: (name: string) => string | undefined;
  maxRecursionDepth?: number;
}

export interface WorkflowRunOpts {
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
}

/** Run a workflow script. Core (no resume/isolation/lifecycle/schema yet — those land in Tasks 6-8). */
export async function runWorkflow(_ignored: string, opts: WorkflowRunOpts, deps: WorkflowRunDeps): Promise<WorkflowRunResult> {
  const runId = opts.runId ?? deps.genRunId();
  const maxAgents = opts.maxAgents ?? 1000;
  const concurrency = Math.min(opts.concurrency ?? 3, 16);
  const maxRecursion = opts.maxRecursionDepth ?? deps.maxRecursionDepth ?? 3;
  const budgetTotal = opts.budget?.total ?? Number.POSITIVE_INFINITY;

  let callIndex = 0;
  const phaseCounts = new Map<string, { agents: number; cached: number; reRun: number }>();
  let currentPhase = "default";
  let agentCount = 0;
  let spent = 0;
  const logs: unknown[] = [];

  const nextCallIndex = () => callIndex++;
  const phaseOf = (title: string, _opts?: { budget?: number }): void => {
    currentPhase = title;
    if (!phaseCounts.has(title)) phaseCounts.set(title, { agents: 0, cached: 0, reRun: 0 });
  };

  // The agent() global — spawns a child, journals call+result by index.
  const agent = async (prompt: string, callOpts: Record<string, unknown> = {}): Promise<unknown> => {
    if (agentCount >= maxAgents) throw new Error(`max agents (${maxAgents}) exceeded`);
    const remaining = budgetTotal - spent;
    if (remaining <= 0) throw new Error("token budget exceeded");
    const idx = nextCallIndex();
    const label = (callOpts.label as string) ?? `agent ${idx}`;
    const phase = (callOpts.phase as string) ?? currentPhase;
    deps.journal.append(runId, { type: "agent:call", callIndex: idx, label, phase, prompt, opts: callOpts, ts: Date.now() });
    const pc = phaseCounts.get(phase) ?? { agents: 0, cached: 0, reRun: 0 };
    pc.agents++; pc.reRun++;
    phaseCounts.set(phase, pc);
    agentCount++;
    const res = await deps.spawn(prompt, {
      agent: (callOpts.agentType as string) ?? "general-purpose",
      ...(callOpts.model ? { model: callOpts.model as string } : {}),
      ...(callOpts.tier ? { tier: callOpts.tier as string } : {}),
      ...(callOpts.lifecycle ? { lifecycle: callOpts.lifecycle as string } : {}),
      ...(callOpts.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      runId,
    });
    spent += res.tokenTotal ?? 0;
    deps.journal.append(runId, { type: "agent:result", callIndex: idx, childRunId: res.runId, result: res.status === "completed" ? res.finalText : null, status: res.status, ...(res.costTotal != null ? { costTotal: res.costTotal } : {}), ...(res.tokenTotal != null ? { tokenTotal: res.tokenTotal } : {}), ts: Date.now() });
    return res.status === "completed" ? res.finalText : null;
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
    const childScript = deps.resolveWorkflow(name);
    if (!childScript) throw new Error(`workflow '${name}' not found`);
    if (maxRecursion - 1 < 0) throw new Error("workflow recursion depth exceeded");
    const childResult = await runWorkflow("child", {
      script: childScript,
      args: childArgs,
      mode: opts.mode,
      runId: deps.genRunId(),
      budget: { total: budgetTotal - spent },
      maxAgents: maxAgents - agentCount,
      maxRecursionDepth: maxRecursion - 1,
    }, deps);
    if (childResult.status === "aborted") throw new Error(`child workflow '${name}' aborted: ${childResult.error ?? "unknown"}`);
    return childResult.result;
  };

  // The HelperCtx shared by all 7 helpers.
  const helperCtx: helpers.HelperCtx = {
    spawn: async (prompt, hOpts) => deps.spawn(prompt, { agent: hOpts?.agent ?? "reviewer", runId }),
    journal: deps.journal,
    runId,
    ...(opts.budget ? { budget: { spent: () => spent, remaining: () => budgetTotal - spent } } : {}),
    ...(deps.onCheckpoint ? { onCheckpoint: deps.onCheckpoint } : {}),
    ...(deps.getModelContextWindow ? { getModelContextWindow: deps.getModelContextWindow } : {}),
    nextCallIndex,
  };

  // Controller note 1: wrap each helper to journal helper:call (with callIndex + name + args)
  // before calling, and helper:result after. The nextCallIndex fn is shared with agent() so
  // the positional index is monotonic across all call types.
  const wrapHelper = <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const idx = nextCallIndex();
      deps.journal.append(runId, { type: "helper:call", callIndex: idx, name, args, ts: Date.now() });
      const result = await fn(...args);
      deps.journal.append(runId, { type: "helper:result", callIndex: idx, name, result, ts: Date.now() });
      return result;
    };
  };

  const wrappedHelpers: RealmDeps = {
    agent, parallel, pipeline, phase: phaseOf, workflow,
    verify: wrapHelper("verify", (item: unknown, o?: Record<string, unknown>) => helpers.verify(item, (o ?? {}) as never, helperCtx)),
    judgePanel: wrapHelper("judgePanel", (a: unknown[], o?: Record<string, unknown>) => helpers.judgePanel(a, (o ?? {}) as never, helperCtx)),
    loopUntilDry: wrapHelper("loopUntilDry", (o: Record<string, unknown>) => helpers.loopUntilDry(o as never, helperCtx)),
    completenessCheck: wrapHelper("completenessCheck", (t: unknown, r: unknown) => helpers.completenessCheck(t, r, helperCtx)),
    gate: wrapHelper("gate", (t: (fb: string | undefined, n: number) => unknown, v: (val: unknown) => { ok: boolean; feedback?: string }, o?: Record<string, unknown>) => helpers.gate(t as never, v as never, (o ?? {}) as never, helperCtx) as Promise<unknown>),
    retry: wrapHelper("retry", (t: (n: number) => unknown, o?: Record<string, unknown>) => helpers.retry(t as never, (o ?? {}) as never, helperCtx)),
    checkpoint: wrapHelper("checkpoint", (p: string, o?: Record<string, unknown>) => helpers.checkpoint(p, (o ?? {}) as never, helperCtx)),
    log: (m: unknown) => logs.push(m),
    args: opts.args,
    cwd: process.cwd(),
    budget: { total: budgetTotal, spent: () => spent, remaining: () => budgetTotal - spent },
  };

  const realm = buildRealm(wrappedHelpers);
  deps.journal.append(runId, { type: "wf:started", runId, script: opts.script, args: opts.args, phases: [], ts: Date.now() });

  try {
    const script = compileWorkflowScript(opts.script);
    const result = await script.runInContext(realm);
    // Controller note 3: guard costTotal/tokenTotal computation for undefined runRegistry entries.
    const todoEntry = deps.runRegistry.get(runId);
    const todoId = todoEntry?.todoId ?? null;
    const childRuns = deps.runRegistry.list().filter((r) => (r.todoId ?? null) === todoId);
    const costTotal = childRuns.reduce((s, r) => s + (r.costTotal ?? 0), 0);
    const tokenTotal = childRuns.reduce((s, r) => s + (r.tokenTotal ?? 0), 0);
    deps.journal.append(runId, { type: "wf:completed", runId, result, ...(costTotal ? { costTotal } : {}), ...(tokenTotal ? { tokenTotal } : {}), ts: Date.now() });
    return { runId, status: "completed", result, ...(costTotal ? { costTotal } : {}), ...(tokenTotal ? { tokenTotal } : {}), phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
  } catch (e) {
    const reason = (e as Error).message;
    deps.journal.append(runId, { type: "wf:aborted", runId, reason, ts: Date.now() });
    return { runId, status: "aborted", error: reason, phases: [...phaseCounts.entries()].map(([title, c]) => ({ title, ...c })) };
  }
}