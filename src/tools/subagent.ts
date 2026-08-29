// src/tools/subagent.ts
import { resolve } from "node:path";
import { statSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { ForegroundLock } from "../engine/concurrency-lock.ts";
import type { SpawnResult } from "../engine/spawnSubagent.ts";
import { spawnSubagent } from "../engine/spawnSubagent.ts";
import type { BackendRegistry } from "../backend/port.ts";
import type { LifecycleRunDeps } from "../lifecycle/run-lifecycle.ts";
import type { LifecycleDef } from "../lifecycle/lifecycle-types.ts";
import type { AsyncRunnerDeps } from "../runtime/async-runner.ts";
import { runBackground } from "../runtime/async-runner.ts";
import type { Scheduler } from "../scheduling/scheduler.ts";

export const subagentParams = Type.Object({
  agent: Type.String({ description: "Agent name from the registry (builtin, project, or global)." }),
  task: Type.String({ description: "The prompt to hand the child subagent." }),
  todoId: Type.Optional(Type.String({ description: "Explicit link to an existing open/in_progress armory-todo todo. Omit to create a fleet task." })),
  track: Type.Optional(Type.Boolean({ description: "Default true. Pass false only for throwaway lookups that don't represent real work." })),
  model: Type.Optional(Type.String({ description: 'Override the agent model, e.g. "anthropic/claude-sonnet-4".' })),
  lifecycle: Type.Optional(Type.String({ description: "Run a multi-phase superpowers lifecycle by name (e.g. 'default') instead of a single delegate. Tool-driven lifecycles run end-to-end (auto) — checkpoints are a /fleet panel feature." })),
  auto: Type.Optional(Type.Boolean({ description: "Only relevant with `lifecycle`. Tool-driven is always auto; this flag is forward-compat. Panel-driven uses --auto on /fleet-implement." })),
  background: Type.Optional(Type.Boolean({ description: "Fire without awaiting. The run goes to the async/bg pool on an isolated git worktree; this returns { runId, status: 'background' } immediately. Foreground (default) awaits the result." })),
  isolation: Type.Optional(Type.Union([
    Type.Literal("worktree"),
    Type.Literal("none"),
    Type.Literal("auto"),
  ], { description: "Edit isolation for background runs. 'worktree' = git worktree (requires a git repo; fails sync if not). 'none' = in-place in cwd (no isolation; parallel edits may conflict). 'auto' (default) = worktree when cwd is a git repo, in-place otherwise." })),
  schedule: Type.Optional(Type.String({ description: 'Schedule the run instead of firing now: a cron string ("0 9 * * 1-5"), an interval ("30m"/"2h"), or a one-shot ISO datetime ("2026-07-25T14:00"). Returns { scheduleId, nextFire }. Session-scoped (fires only while pi is open); no catch-up.' })),
  maxTurns: Type.Optional(Type.Number({ description: 'Per-run turn budget (default 20). Raise for complex multi-step tasks (e.g. 40) so the subagent doesn\'t hit the budget mid-task; lower for trivial lookups.' })),
  readOnly: Type.Optional(Type.Boolean({ description: 'Default false. Pass true ONLY for dispatches that will NOT mutate the working directory (review/audit, or research that writes no scratch files). A readOnly dispatch bypasses the foreground single-slot lock so multiple readOnly dispatches — and/or a readOnly alongside a write dispatch — can run in parallel. The caller is responsible for the assertion: mislabeling a dispatch that edits as readOnly risks in-place edit conflicts. Has no effect on background/scheduled runs (they use their own locks).' })),
  skills: Type.Optional(Type.Array(Type.String(), { description: 'Skills to load for this dispatch (opt-in). By default a dispatch loads NO skills (#32 — lean substrate; previously an agent with no skills field loaded ALL ~42 installed skills, ~570K tokens / ~59% of context). Pass skill names from the installed arsenal (e.g. ["executing-plans", "test-driven-development"]) to opt in. For a direct dispatch, this replaces the agent\'s frontmatter skills (pass [] to load zero). For a lifecycle dispatch, this is ADDITIVE — the phase\'s designed skill bundle always loads and these are merged on top (a caller cannot strip a phase\'s required skills).' })),
  modelFallback: Type.Optional(Type.String({ description: 'Model to retry with if the primary dispatch fails with a retryable provider rate-limit / auth failure (stopReason "error"). The fleet retries ONCE on this model and relinks the same tracked todo. Surface the model that served the retry in the result details (retriedWithModel). Per the AGENTS.md "Ollama primary + OpenRouter fallback" pattern. No effect on non-retryable failures (turn budget, agent-not-found, abort). Direct foreground dispatches only — background/scheduled/lifecycle retries are a follow-up.' })),
  cwd: Type.Optional(Type.String({ description: 'The dispatch target\'s working directory. Default: the session cwd (backward-compat). Scoped to this path: the child\'s working dir, context-file cascade, skill discovery, and memory scopes. Accepts paths OUTSIDE the session cwd (a sibling repo) — that\'s the #20 fix. Relative paths resolve against the session cwd.' })),
});

export type SubagentInput = Static<typeof subagentParams>;

/** #32: merge a lifecycle phase's skill bundle with the caller's `skills` param.
 *  Additive + deduped — the phase's designed skills always load; the caller can add extras but
 *  cannot strip phase skills (avoids the footgun where a caller passing `skills: ["tdd"]` with
 *  `lifecycle: "default"` would silently drop `brainstorming` from the brainstorm phase). */
export function mergeLifecycleSkills(phaseSkills: string[] | undefined, callerSkills: string[] | undefined): string[] {
  return [...new Set([...(phaseSkills ?? []), ...(callerSkills ?? [])])];
}

/** SPEC-6-5: validate + resolve a dispatch cwd. Returns { cwd } on success or { error } on failure. */
export function resolveDispatchCwd(raw: string | undefined, parentCwd: string): { cwd?: string; error?: string } {
  if (raw === undefined || raw === "") return { cwd: undefined };   // default → parentCwd (handled by spawnSubagent)
  const abs = resolve(parentCwd, raw);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return { error: `cwd is not a directory: ${abs}` };
    return { cwd: abs };
  } catch {
    return { error: `cwd does not exist: ${abs}` };
  }
}

export interface SubagentToolDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: ForegroundLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory
  parentModel: { provider: string; id: string };
  parentCwd: string;
  /** SPEC-4: lifecycle registry + spawn adapter (tool-driven = auto). */
  lifecycleRegistry: Map<string, LifecycleDef>;
  lifecycleRuns: Map<string, import("../lifecycle/lifecycle-types.ts").LifecycleRunRecord>;
  lifecycleDeps: Omit<LifecycleRunDeps, "spawn">;
  /** SPEC-5a: async/bg runtime deps. Present when the extension wires the operational runtime. */
  asyncRunner?: AsyncRunnerDeps;
  /** SPEC-5a: scheduler. Present when the extension wires scheduling. */
  scheduler?: Scheduler;
  /** SPEC-5a: live bg run status rows for the /fleet panel. Optional. */
  bgRuns?: import("../panel/bg-runs-store.ts").BgRunsStore;
  /** SPEC-5b-1: durable per-run conversation log. Optional — Runs tab + journaling disabled when absent. */
  runLog?: import("../runtime/run-log.ts").RunLog;
  /** SPEC-6-1: tier registry for cost-aware model routing. Optional. */
  tierRegistry?: import("../tiers/tier-registry.ts").TierRegistry;
  /** SPEC-6-1: model registry for contextWindow lookups (contextFloor + ctx%). Optional. */
  modelRegistry?: import("../tiers/resolve.ts").ModelRegistryLike;
  /** SPEC-6-1: tier store for the /fleet Tiers view writes. Optional. */
  tierStore?: import("../tiers/tier-store.ts").TierStore;
  /** SPEC-6-1: rebuild the tier registry after a panel write. */
  reloadTiers?: () => void;
  /** SPEC-6-1: model contextWindow resolver for Runs-tab ctx% (Surface C). Optional — ctx% hidden when absent. */
  getModelContextWindow?: (model: string) => number | undefined;
  /** #39 tail: a global default fallback model so a retryable provider failure (stopReason "error")
   *  retries once even without a per-dispatch `modelFallback` param. Wired from the
   *  `ARMORY_FLEET_MODEL_FALLBACK` env var in index.ts; a settings.json field is a follow-up.
   *  Per-dispatch `modelFallback` (when passed) takes precedence. Applies to the direct foreground
   *  path, the foreground lifecycle spawn, and the background/scheduled spawn. */
  defaultModelFallback?: string;
  /** SPEC-6-5: notify hook for cross-cwd dispatch surfacing. Wired from ctx.ui.notify in index.ts. */
  onNotify?: (message: string, kind?: "info" | "warning" | "error") => void;
}

/** Build the pi.registerTool definition. Thin wrapper over spawnSubagent. */
export function createSubagentTool(deps: SubagentToolDeps) {
  return {
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a named armory-native subagent (foreground, synchronous). The run is tracked in armory-todo by default.",
    promptSnippet: "Delegate a focused task to a subagent",
    promptGuidelines: [
      "Use subagent to delegate an isolated, well-scoped task to a named agent; it runs in the foreground and returns the result + a runId.",
      "Pass todoId to link the run to an existing open todo you see in the Open TODOs block; otherwise fleet creates a tracked fleet task.",
      "Pass track:false only for trivial throwaway lookups that don't represent real work.",
      "Pass readOnly:true for dispatches that will NOT edit the working directory (review/audit, or research that writes no scratch files). It bypasses the foreground single-slot lock so multiple readOnly dispatches can run in parallel. Only use it when you are certain the child won't mutate cwd — mislabeling risks edit conflicts.",
      "By default a dispatch loads NO skills (lean substrate). If the task needs a skill (e.g. test-driven-development for a TDD task, executing-plans for a plan-execution task), pass its name in the `skills` array to opt in — loading all skills by default wastes ~59% of the context window.",
      "Pass `modelFallback` so a transient provider rate-limit / auth failure (stopReason 'error') auto-retries once on the fallback model instead of failing the dispatch. Per the AGENTS.md 'Ollama primary + OpenRouter fallback' pattern — don't let infra limits break a dispatch chain.",
      "For web tasks, dispatch with the firecrawl skill the child needs (e.g. skills: [\"firecrawl-scrape\"] / [\"firecrawl-search\"]) — children now discover skills from `~/.agents/skills` + `~/.pi/agent/skills`, matching your surface. Curl stays the right call for raw HTTP probes, smoke tests, and plain JSON/text APIs where JS rendering isn't needed (per the AGENTS.md firecrawl-first/curl-fallback preference).",
      "Foreground concurrency is SESSION-LEVEL, not per-dispatch: write dispatches serialize through one shared lock sized by ARMORY_FLEET_FOREGROUND_CONCURRENCY. At the default (1) a 2nd write dispatch is rejected fail-fast (the error names the held runId) — dispatch sequentially (await each) or use readOnly:true for parallel read-only work. Raise the env cap only if you accept parallel in-place edits (conflict risk).",
    ],
    parameters: subagentParams,
    async execute(_toolCallId: string, params: SubagentInput, signal: AbortSignal, _onUpdate: unknown, _ctx: any) {
      // SPEC-6-5: validate + resolve the dispatch cwd before any routing.
      const { cwd: resolvedCwd, error: cwdErr } = resolveDispatchCwd(params.cwd, deps.parentCwd);
      if (cwdErr) return { isError: true, content: [{ type: "text" as const, text: cwdErr }] };
      if (resolvedCwd && resolvedCwd !== deps.parentCwd) {
        deps.onNotify?.(`scoped to ${resolvedCwd} (≠ session ${deps.parentCwd})`, "info");
      }
      // SPEC-5a: background + schedule routing (Q1/Q2/Q5).
      if (params.background && params.schedule) {
        return { isError: true, content: [{ type: "text" as const, text: "A scheduled run is inherently background — pass only one of `background` or `schedule`, not both." }] };
      }
      if (params.schedule) {
        if (!deps.scheduler) return { isError: true, content: [{ type: "text" as const, text: "scheduling not configured (scheduler missing)" }] };
        const id = deps.scheduler.register({ task: params.task, expression: params.schedule, lifecycle: params.lifecycle ?? "default", auto: params.auto ?? true, isolation: params.isolation, cwd: resolvedCwd });
        const entry = deps.scheduler.list().find((s) => s.id === id);
        return { content: [{ type: "text" as const, text: `scheduled: ${id} · next fire: ${entry?.nextFire?.toISOString() ?? "(paused)"}` }], details: { scheduleId: id, nextFire: entry?.nextFire ?? null } };
      }
      if (params.background) {
        if (!deps.asyncRunner) return { isError: true, content: [{ type: "text" as const, text: "background runs not configured (asyncRunner missing)" }] };
        const handle = runBackground(params.task, { deps: deps.asyncRunner, lifecycle: params.lifecycle ?? "default", mode: "auto", isolation: params.isolation, cwd: resolvedCwd });
        if (handle.status === "failed") return { isError: true, content: [{ type: "text" as const, text: handle.error }] };
        return { content: [{ type: "text" as const, text: `background run: ${handle.runId}` }], details: handle };
      }
      if (params.lifecycle) {
        const { runLifecycle } = await import("../lifecycle/run-lifecycle.ts");
        const { withModelFallbackRetry } = await import("../engine/retry-fallback.ts");
        const lifecycleFullDeps: LifecycleRunDeps = {
          ...deps.lifecycleDeps,
          // #39 tail: wrap the phase spawn so a retryable provider failure retries once on the
          // fallback (per-dispatch `modelFallback` param OR the global `defaultModelFallback` dep).
          spawn: withModelFallbackRetry(async (o) => spawnSubagent({
            agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
            skillsOverride: mergeLifecycleSkills(o.skills, params.skills), backendOverride: o.backend,
            registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
            backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd, runLog: deps.runLog, signal,
            maxTurns: params.maxTurns,
            tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
            readOnly: params.readOnly,
            cwd: o.cwd,
          }), params.modelFallback ?? deps.defaultModelFallback, signal),
        };
        const res = await runLifecycle(params.task, params.lifecycle, {
          deps: lifecycleFullDeps, mode: "auto",
          entryCwd: resolvedCwd,
          onCheckpoint: async (phase) => phase.status === "failed" ? { action: "abort" } : { action: "continue" },
        });
        const isError = res.status === "failed" || res.status === "aborted";
        const summary = `lifecycle ${res.lifecycleName}: ${res.status} (${res.phases.length} phases)\n` +
          res.phases.map((p) => `  ${p.name}: ${p.status}${p.paths.length ? " → " + p.paths.join(", ") : ""}`).join("\n");
        return {
          content: [{ type: "text" as const, text: isError ? (res.error ?? res.status) : summary }],
          details: { runId: res.runId, todoId: res.todoId, lifecycle: res.lifecycleName, status: res.status, phases: res.phases.length },
          isError,
        };
      }
      const res: SpawnResult = await spawnSubagent({
        agent: params.agent,
        task: params.task,
        todoId: params.todoId,
        track: params.track,
        model: params.model,
        readOnly: params.readOnly,
        skillsOverride: params.skills,
        registry: deps.registry,
        todoSync: deps.todoSync,
        runRegistry: deps.runRegistry,
        lock: deps.lock,
        backendRegistry: deps.backendRegistry,
        parentModel: deps.parentModel,
        parentCwd: deps.parentCwd,
        runLog: deps.runLog,
        signal,
        maxTurns: params.maxTurns,
        tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
        cwd: resolvedCwd,
      });
      // #39: auto-retry on a retryable provider rate-limit / auth failure (stopReason "error").
      // The primary run reverted its linked todo to open (finishRun -> markRunTodoReverted), so the
      // retry relinks the SAME todoId to continue the tracked task. Retry ONCE, only on the direct
      // foreground path, only if a distinct fallback model was provided. The retry's runId differs
      // from the primary's (each spawnSubagent call mints its own); details.retriedWithModel marks it.
      // #39 tail: the fallback comes from the per-dispatch `modelFallback` param OR the global
      // `defaultModelFallback` dep (wired from ARMORY_FLEET_MODEL_FALLBACK) — per-dispatch wins.
      const fallback = params.modelFallback ?? deps.defaultModelFallback;
      let retriedWithModel: string | undefined;
      let finalRes = res;
      if (
        res.status === "failed" && res.retryable && fallback &&
        fallback !== res.model && !signal.aborted
      ) {
        finalRes = await spawnSubagent({
          agent: params.agent,
          task: params.task,
          todoId: res.todoId ?? undefined,
          track: params.track,
          model: fallback,
          readOnly: params.readOnly,
          skillsOverride: params.skills,
          registry: deps.registry,
          todoSync: deps.todoSync,
          runRegistry: deps.runRegistry,
          lock: deps.lock,
          backendRegistry: deps.backendRegistry,
          parentModel: deps.parentModel,
          parentCwd: deps.parentCwd,
          runLog: deps.runLog,
          signal,
          maxTurns: params.maxTurns,
          tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
          cwd: resolvedCwd,
        });
        retriedWithModel = fallback;
      }
      // #59: when the fallback retry ALSO fails, surface the PRIMARY's failure too — returning
      // only the fallback's error masked why the primary (e.g. an explicit model string) failed
      // at all, making provider diagnosis impossible from the controller's seat.
      if (retriedWithModel && finalRes.status === "failed" && res.error && res.error !== finalRes.error) {
        finalRes = {
          ...finalRes,
          error: `primary '${res.model}' failed: ${res.error}; fallback '${retriedWithModel}' failed: ${finalRes.error ?? finalRes.status}`,
        };
      }
      // #58: a retryable failure with NO fallback configured (neither per-dispatch nor global)
      // means the auto-retry silently didn't fire — surface that, and how to enable it, exactly
      // when it matters. Mutually exclusive with the #59 composition above (a retry implies a
      // fallback was configured).
      if (finalRes.status === "failed" && finalRes.retryable && !fallback) {
        finalRes = {
          ...finalRes,
          error: `${finalRes.error ?? finalRes.status}\n(no modelFallback configured — pass modelFallback or set ARMORY_FLEET_MODEL_FALLBACK to enable one-shot auto-retry)`,
        };
      }
      const isError = finalRes.status === "failed" || finalRes.status === "aborted";
      // #61: a run that "completed" without a single tool call is usually a premature return
      // (the child narrated a plan and ended without acting) — flag it in-band so the controller
      // verifies (git status/log) instead of trusting a terse planning statement as a completion.
      const zeroToolRun = !isError && (finalRes.toolCallCount ?? 0) === 0;
      const resultText = isError
        ? (finalRes.error ?? finalRes.status)
        : zeroToolRun
          ? `[FLEET] zero-tool-call run — likely a premature return (#61); verify with git status/log before trusting this result.\n\n${finalRes.finalText}`
          : finalRes.finalText;
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: {
          runId: finalRes.runId, todoId: finalRes.todoId, agent: finalRes.agent, model: finalRes.model,
          status: finalRes.status, durationMs: finalRes.durationMs, tokenTotal: finalRes.tokenTotal,
          retriedWithModel,
          filesTouched: finalRes.filesTouched, reachedSummary: finalRes.reachedSummary,
          toolCallCount: finalRes.toolCallCount,   // #61: zero = the premature-return signal
        },
        isError,
      };
    },
  };
}
