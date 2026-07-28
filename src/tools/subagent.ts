// src/tools/subagent.ts
import { Type, type Static } from "typebox";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
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
});

export type SubagentInput = Static<typeof subagentParams>;

export interface SubagentToolDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
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
    ],
    parameters: subagentParams,
    async execute(_toolCallId: string, params: SubagentInput, signal: AbortSignal, _onUpdate: unknown, _ctx: any) {
      // SPEC-5a: background + schedule routing (Q1/Q2/Q5).
      if (params.background && params.schedule) {
        return { isError: true, content: [{ type: "text" as const, text: "A scheduled run is inherently background — pass only one of `background` or `schedule`, not both." }] };
      }
      if (params.schedule) {
        if (!deps.scheduler) return { isError: true, content: [{ type: "text" as const, text: "scheduling not configured (scheduler missing)" }] };
        const id = deps.scheduler.register({ task: params.task, expression: params.schedule, lifecycle: params.lifecycle ?? "default", auto: params.auto ?? true });
        const entry = deps.scheduler.list().find((s) => s.id === id);
        return { content: [{ type: "text" as const, text: `scheduled: ${id} · next fire: ${entry?.nextFire?.toISOString() ?? "(paused)"}` }], details: { scheduleId: id, nextFire: entry?.nextFire ?? null } };
      }
      if (params.background) {
        if (!deps.asyncRunner) return { isError: true, content: [{ type: "text" as const, text: "background runs not configured (asyncRunner missing)" }] };
        const handle = runBackground(params.task, { deps: deps.asyncRunner, lifecycle: params.lifecycle ?? "default", mode: "auto", isolation: params.isolation });
        if (handle.status === "failed") return { isError: true, content: [{ type: "text" as const, text: handle.error }] };
        return { content: [{ type: "text" as const, text: `background run: ${handle.runId}` }], details: handle };
      }
      if (params.lifecycle) {
        const { runLifecycle } = await import("../lifecycle/run-lifecycle.ts");
        const lifecycleFullDeps: LifecycleRunDeps = {
          ...deps.lifecycleDeps,
          spawn: async (o) => spawnSubagent({
            agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
            skillsOverride: o.skills, backendOverride: o.backend,
            registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
            backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd, runLog: deps.runLog, signal,
            maxTurns: params.maxTurns,
            tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
          }),
        };
        const res = await runLifecycle(params.task, params.lifecycle, {
          deps: lifecycleFullDeps, mode: "auto",
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
      });
      const isError = res.status === "failed" || res.status === "aborted";
      return {
        content: [{ type: "text" as const, text: isError ? (res.error ?? res.status) : res.finalText }],
        details: {
          runId: res.runId, todoId: res.todoId, agent: res.agent, model: res.model,
          status: res.status, durationMs: res.durationMs, tokenTotal: res.tokenTotal,
        },
        isError,
      };
    },
  };
}