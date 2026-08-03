// src/workflows/runtime/adapters.ts — SPEC-6-3 production spawn/lifecycle adapters.
// Wires real spawnSubagent + runLifecycle into WorkflowRunDeps via a per-workflow concurrency pool.
// Each admitted child gets a fresh SingleSlotLock (NOT the extension's foreground singleton).
import { ConcurrencyPool } from "../../runtime/concurrency-pool.ts"
import { SingleSlotLock } from "../../engine/concurrency-lock.ts"
import type { SpawnOptions, SpawnResult } from "../../engine/spawnSubagent.ts"
import type { LifecycleRunResult, LifecycleRunOpts } from "../../lifecycle/run-lifecycle.ts"

/** The deps the adapter needs from index.ts (Task 13). Tests inject spawnSubagentFn + runLifecycleFn. */
export interface WorkflowAdapterBase {
  registry: Map<string, unknown>
  todoSync: unknown
  runRegistry: unknown
  backendRegistry: unknown
  parentModel: { provider: string; id: string }
  parentCwd: string
  runLog?: unknown
  tierRegistry?: unknown
  modelRegistry?: unknown
  lifecycleDeps: unknown
  spawnSubagentFn: (opts: SpawnOptions) => Promise<SpawnResult>
  runLifecycleFn: (task: string, name: string, opts: LifecycleRunOpts) => Promise<LifecycleRunResult>
}

export interface WorkflowAdapterOpts {
  concurrency: number
  signal: AbortSignal
}

export type WorkflowSpawnResult = {
  finalText: string
  runId: string
  status: "completed" | "failed"
  costTotal?: number
  tokenTotal?: number
}

export type WorkflowLifecycleResult = {
  status: "completed" | "failed" | "aborted"
  finalText: string
  costTotal?: number
  tokenTotal?: number
  error?: string
}

export function createWorkflowAdapters(
  base: WorkflowAdapterBase,
  opts: WorkflowAdapterOpts,
): Pick<import("../runner.ts").WorkflowRunDeps, "spawn" | "runLifecycle"> {
  const pool = new ConcurrencyPool(Math.min(Math.max(opts.concurrency, 1), 16))

  const spawn: import("../runner.ts").WorkflowRunDeps["spawn"] = async (prompt, spawnOpts) => {
    return pool.withSlot(async () => {
      const lock = new SingleSlotLock()

      const signals: AbortSignal[] = [opts.signal]
      if (spawnOpts.timeoutMs && spawnOpts.timeoutMs > 0) {
        signals.push(AbortSignal.timeout(spawnOpts.timeoutMs))
      }
      const combined = AbortSignal.any(signals)

      const result = await base.spawnSubagentFn({
        agent: spawnOpts.agent,
        task: prompt,
        ...(spawnOpts.model ? { model: spawnOpts.model } : {}),
        ...(spawnOpts.tier ? { tierOverride: spawnOpts.tier } : {}),
        ...(spawnOpts.skills ? { skillsOverride: spawnOpts.skills } : {}),
        ...(spawnOpts.backend ? { backendOverride: spawnOpts.backend } : {}),
        lock,
        signal: combined,
        registry: base.registry as SpawnOptions["registry"],
        todoSync: base.todoSync as SpawnOptions["todoSync"],
        runRegistry: base.runRegistry as SpawnOptions["runRegistry"],
        backendRegistry: base.backendRegistry as SpawnOptions["backendRegistry"],
        parentModel: base.parentModel,
        parentCwd: base.parentCwd,
        ...(base.runLog ? { runLog: base.runLog as SpawnOptions["runLog"] } : {}),
        ...(base.tierRegistry ? { tierRegistry: base.tierRegistry as SpawnOptions["tierRegistry"] } : {}),
        ...(base.modelRegistry ? { modelRegistry: base.modelRegistry as SpawnOptions["modelRegistry"] } : {}),
      })

      return {
        finalText: result.finalText,
        runId: result.runId,
        status: result.status === "completed" ? "completed" : "failed",
        ...(result.costTotal != null ? { costTotal: result.costTotal } : {}),
        ...(result.tokenTotal != null ? { tokenTotal: result.tokenTotal } : {}),
      }
    })
  }

  const runLifecycle: import("../runner.ts").WorkflowRunDeps["runLifecycle"] = async (
    task,
    name,
    lcOpts,
  ) => {
    return pool.withSlot(async () => {
      const result = await base.runLifecycleFn(task, name, {
        deps: base.lifecycleDeps as LifecycleRunOpts["deps"],
        mode: lcOpts.mode,
        onCheckpoint: async () => ({ action: "continue" as const }),
        ...(lcOpts.worktreePath ? { worktreePath: lcOpts.worktreePath } : {}),
      })

      const finalText = result.phases.length > 0
        ? (result.phases[result.phases.length - 1]?.summary ?? result.error ?? "")
        : (result.error ?? "")

      return {
        status: result.status,
        finalText,
        ...(result.error ? { error: result.error } : {}),
        ...((result as unknown as Record<string, unknown>).costTotal != null ? { costTotal: (result as unknown as Record<string, unknown>).costTotal as number } : {}),
        ...((result as unknown as Record<string, unknown>).tokenTotal != null ? { tokenTotal: (result as unknown as Record<string, unknown>).tokenTotal as number } : {}),
      } as WorkflowLifecycleResult
    })
  }

  return { spawn, runLifecycle }
}
