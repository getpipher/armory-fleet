import { test } from "node:test"
import { strictEqual, deepEqual, notEqual, ok } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowAdapters } from "../src/workflows/runtime/adapters.ts"
import { SingleSlotLock } from "../src/engine/concurrency-lock.ts"
import type { SpawnResult } from "../src/engine/spawnSubagent.ts"
import type { LifecycleRunResult } from "../src/lifecycle/run-lifecycle.ts"

let tmpDir: string
test.before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-adapters-"))
  process.env.TODO_DIR = tmpDir
})
test.after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.TODO_DIR
})

const baseLock = new SingleSlotLock()

function spawnResult(finalText: string): SpawnResult {
  return {
    status: "completed",
    finalText,
    runId: "fl-test-" + Math.random().toString(36).slice(2, 8),
    todoId: null,
    agent: "general-purpose",
    model: "test/model",
    durationMs: 10,
    tokenTotal: 42,
    costTotal: 0.001,
    contextTokens: 100,
  }
}

function lifecycleResult(summary: string, status: "completed" | "failed" = "completed"): LifecycleRunResult {
  return {
    runId: "lc-test-" + Math.random().toString(36).slice(2, 8),
    lifecycleName: "test-lifecycle",
    task: "test task",
    backend: "pi",
    mode: "checkpointed",
    status,
    phases: [
      { name: "phase-1", summary: "intermediate", paths: [], status: "completed", reviseCount: 0 },
      { name: "phase-2", summary, paths: [], status, reviseCount: 0 },
    ],
    startedAt: Date.now(),
    endedAt: Date.now(),
    todoId: null,
    ...(status === "failed" ? { error: "phase failed" } : {}),
  }
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry: new Map(),
    todoSync: {
      linkOrCreateRunTodo: async () => ({ todoId: null }),
      markRunTodoDone: async () => {},
      markRunTodoReverted: async () => {},
    },
    runRegistry: {
      add: () => {},
      update: () => {},
      get: () => undefined,
      list: () => [],
    },
    backendRegistry: {
      get: () => undefined,
      list: () => [],
    },
    parentModel: { provider: "p", id: "m" },
    parentCwd: tmpDir,
    tierRegistry: { get: () => undefined, list: () => [] },
    modelRegistry: { find: () => undefined },
    lifecycleDeps: {
      registry: new Map(),
      agentRegistry: new Map(),
      spawn: async () => spawnResult("ok"),
      todoPort: {
        create: async () => "lc-todo",
        updateProgress: async () => {},
        complete: async () => {},
        revert: async () => {},
      },
      resolveBackend: () => "pi",
      genRunId: () => "lc-run-" + Math.random().toString(36).slice(2, 8),
    },
    baseLock,
    ...overrides,
  } as Record<string, unknown>
}

test("spawn adapter forwards overrides signal timeout and bypasses the foreground singleton", async () => {
  const seen: Array<Record<string, unknown>> = []
  const adapters = createWorkflowAdapters(
    base({
      spawnSubagentFn: async (opts: Record<string, unknown>) => {
        seen.push(opts)
        return spawnResult("ok")
      },
    }) as never,
    { concurrency: 2, signal: new AbortController().signal },
  )
  await adapters.spawn("task", {
    agent: "general-purpose",
    runId: "wf-1",
    tier: "high",
    skills: ["review"],
    backend: "claude",
    timeoutMs: 500,
  })
  strictEqual(seen[0]?.tierOverride, "high")
  deepEqual(seen[0]?.skillsOverride, ["review"])
  strictEqual(seen[0]?.backendOverride, "claude")
  notEqual(seen[0]?.lock, baseLock)
  ok(seen[0]?.signal instanceof AbortSignal)
})

test("workflow pool permits two children and queues the third", async () => {
  let active = 0
  let max = 0
  const releases: Array<() => void> = []
  const adapters = createWorkflowAdapters(
    base({
      spawnSubagentFn: async () => {
        active++
        max = Math.max(max, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        return spawnResult("ok")
      },
    }) as never,
    { concurrency: 2, signal: new AbortController().signal },
  )
  const runs = [1, 2, 3].map((n) =>
    adapters.spawn(String(n), { agent: "general-purpose", runId: `wf-${n}` }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  strictEqual(max, 2)
  releases.shift()?.()
  releases.shift()?.()
  await new Promise((resolve) => setImmediate(resolve))
  releases.shift()?.()
  await Promise.all(runs)
})

test("spawn maps SpawnResult to { finalText, runId, status, costTotal, tokenTotal }", async () => {
  const adapters = createWorkflowAdapters(
    base({
      spawnSubagentFn: async () => spawnResult("hello world"),
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  const result = await adapters.spawn("task", { agent: "general-purpose", runId: "wf-1" })
  strictEqual(result.finalText, "hello world")
  strictEqual(result.status, "completed")
  strictEqual(result.tokenTotal, 42)
  strictEqual(result.costTotal, 0.001)
  ok(typeof result.runId, "string")
})

test("runLifecycle maps terminal phase summary to finalText", async () => {
  const adapters = createWorkflowAdapters(
    base({
      runLifecycleFn: async () => lifecycleResult("final summary"),
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  const result = await adapters.runLifecycle!("task", "lc-name", { mode: "checkpointed" })
  strictEqual(result.status, "completed")
  strictEqual(result.finalText, "final summary")
})

test("runLifecycle accumulates child cost and tokens", async () => {
  const adapters = createWorkflowAdapters(
    base({
      runLifecycleFn: async () => ({
        ...lifecycleResult("done"),
        costTotal: 0.5,
        tokenTotal: 500,
      }),
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  const result = await adapters.runLifecycle!("task", "lc-name", { mode: "auto" })
  strictEqual(result.costTotal, 0.5)
  strictEqual(result.tokenTotal, 500)
})

test("runLifecycle forwards worktreePath", async () => {
  let seenOpts: Record<string, unknown> | undefined
  const adapters = createWorkflowAdapters(
    base({
      runLifecycleFn: async (_task: string, _name: string, opts: Record<string, unknown>) => {
        seenOpts = opts
        return lifecycleResult("ok")
      },
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  await adapters.runLifecycle!("task", "lc-name", {
    mode: "checkpointed",
    worktreePath: "/tmp/wt-test",
  })
  strictEqual(seenOpts?.worktreePath, "/tmp/wt-test")
})

test("runLifecycle maps failed lifecycle error to finalText", async () => {
  const adapters = createWorkflowAdapters(
    base({
      runLifecycleFn: async () => ({
        ...lifecycleResult("", "failed"),
        error: "phase failed",
      }),
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  const result = await adapters.runLifecycle!("task", "lc-name", { mode: "auto" })
  strictEqual(result.status, "failed")
  strictEqual(result.error, "phase failed")
  ok(typeof result.finalText, "string")
})

test("lifecycle phase spawn uses the workflow pool and a fresh lock (not baseLock)", async () => {
  const seen: Array<Record<string, unknown>> = []
  const adapters = createWorkflowAdapters(
    base({
      spawnSubagentFn: async (opts: Record<string, unknown>) => {
        seen.push(opts)
        return spawnResult("phase result")
      },
      runLifecycleFn: async (
        _task: string,
        _name: string,
        lcOpts: Record<string, unknown>,
      ) => {
        const deps = lcOpts.deps as { spawn: (o: Record<string, unknown>) => Promise<SpawnResult> }
        await deps.spawn({
          agent: "reviewer",
          task: "phase task",
          lifecycleTodoId: "lc-1",
          skills: ["review"],
          backend: "pi",
        })
        return lifecycleResult("phase ok")
      },
    }) as never,
    { concurrency: 2, signal: new AbortController().signal },
  )
  await adapters.runLifecycle!("task", "lc-name", { mode: "auto" })
  strictEqual(seen.length, 1, "lifecycle called spawnSubagentFn once via deps.spawn")
  strictEqual(seen[0]?.agent, "reviewer")
  strictEqual(seen[0]?.lifecycleTodoId, "lc-1")
  deepEqual(seen[0]?.skillsOverride, ["review"])
  strictEqual(seen[0]?.backendOverride, "pi")
  notEqual(seen[0]?.lock, baseLock, "phase spawn got a fresh lock, not the base singleton")
  ok(seen[0]?.signal instanceof AbortSignal, "phase spawn got a combined signal")
})

test("checkpoint bridge: bridge rejecting returns abort", async () => {
  const adapters = createWorkflowAdapters(
    base({
      onCheckpointBridge: async () => false,
      runLifecycleFn: async (
        _task: string,
        _name: string,
        lcOpts: Record<string, unknown>,
      ) => {
        const onCheckpoint = lcOpts.onCheckpoint as (
          phase: Record<string, unknown>,
          gateResults: unknown[],
        ) => Promise<{ action: string }>
        const decision = await onCheckpoint(
          { name: "phase-1", status: "completed", summary: "ok", paths: [], reviseCount: 0 },
          [],
        )
        strictEqual(decision.action, "abort", "bridge returning false → abort")
        return lifecycleResult("aborted", "completed")
      },
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  await adapters.runLifecycle!("task", "lc-name", { mode: "checkpointed" })
})

test("checkpoint bridge: no bridge defaults to continue", async () => {
  const adapters = createWorkflowAdapters(
    base({
      runLifecycleFn: async (
        _task: string,
        _name: string,
        lcOpts: Record<string, unknown>,
      ) => {
        const onCheckpoint = lcOpts.onCheckpoint as (
          phase: Record<string, unknown>,
          gateResults: unknown[],
        ) => Promise<{ action: string }>
        const decision = await onCheckpoint(
          { name: "phase-1", status: "completed", summary: "ok", paths: [], reviseCount: 0 },
          [],
        )
        strictEqual(decision.action, "continue", "no bridge → auto-continue")
        return lifecycleResult("ok")
      },
    }) as never,
    { concurrency: 1, signal: new AbortController().signal },
  )
  await adapters.runLifecycle!("task", "lc-name", { mode: "checkpointed" })
})
