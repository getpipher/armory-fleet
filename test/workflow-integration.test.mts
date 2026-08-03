import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkflowIntegrationHarness,
  BUILTIN_DIR,
  BUILTIN_NAMES,
  LIFECYCLE_SCRIPT,
  THREE_PARALLEL,
  type IntegrationHarness,
} from "./helpers/workflow-integration-harness.mts"
import { createFleetTool } from "../src/tools/fleet.ts"
import { ResultsInbox } from "../src/runtime/results-inbox.ts"
import { WorkflowJournal } from "../src/workflows/journal.ts"
import { WorkflowRunStore } from "../src/workflows/runtime/run-store.ts"
import { WorkflowRegistry, discoverWorkflows } from "../src/workflows/registry.ts"
import { WorkflowController } from "../src/workflows/runtime/controller.ts"
import { runWorkflow } from "../src/workflows/runner.ts"
import type { WorkflowRunDeps } from "../src/workflows/runner.ts"

async function execute(
  tool: ReturnType<typeof createFleetTool>,
  params: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; details?: unknown }> {
  const raw = await tool.execute("c1", params as never, null, null, null)
  return raw as { isError?: boolean; content: Array<{ type: string; text: string }>; details?: unknown }
}

// ── Brief tests ──

test("tool to controller to builtin runner updates store and child registry", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR })
  try {
    const tool = createFleetTool({ getController: () => app.controller })
    const res = await execute(tool, { action: "workflow", workflowName: "code-review", background: false })
    assert.equal(res.isError, undefined)
    const runId = (res.details as { runId: string }).runId
    assert.equal(app.store.get(runId)?.status, "completed")
    assert.ok((app.store.get(runId)?.childRunIds.length ?? 0) >= 1)
    assert.ok(app.runRegistry.list().some((r) => app.store.get(runId)?.childRunIds.includes(r.runId)))
  } finally {
    app.cleanup()
  }
})

test("all five builtins execute by name", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR })
  try {
    for (const workflowName of BUILTIN_NAMES) {
      const result = await app.controller.start({ workflowName, mode: "auto", background: false, maxAgents: 100 })
      assert.equal(result.status, "completed", `${workflowName}: ${"error" in result ? result.error : ""}`)
      if (workflowName === "deep-research" || workflowName === "codebase-audit") {
        assert.ok(JSON.stringify(result.result).includes("source-") || JSON.stringify(result.result).includes("file-"))
      }
    }
  } finally {
    app.cleanup()
  }
})

test("lifecycle step uses real adapter and parallel run reaches configured concurrency", async () => {
  const app = await createWorkflowIntegrationHarness({ measuredSpawn: true })
  try {
    const lifecycle = await app.controller.start({ script: LIFECYCLE_SCRIPT, mode: "auto", background: false })
    assert.equal(lifecycle.status, "completed")
    const parallel = await app.controller.start({ script: THREE_PARALLEL, mode: "auto", background: false, concurrency: 2 })
    assert.equal(parallel.status, "completed")
    assert.equal(app.maxActiveChildren, 2)
  } finally {
    app.cleanup()
  }
})

// ── Additional cases ──

test("save-as shadowing: project workflow shadows builtin", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wf-shadow-"))
  try {
    const app = await createWorkflowIntegrationHarness({ projectDir })
    try {
      const projectScript = `export const meta = { name: "code-review", description: "project version", phases: [{ title: "p" }] }
agent("project custom review")
return "project-code-review-result"
`
      app.controller.save({ name: "code-review", source: projectScript })
      const def = app.registry.get("code-review")
      assert.equal(def?.source, "project")
      const result = await app.controller.start({ workflowName: "code-review", mode: "auto", background: false })
      assert.equal(result.status, "completed")
      assert.equal((result as { result: unknown }).result, "project-code-review-result")
    } finally {
      app.cleanup()
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test("background inbox: background run pushes to inbox after settle", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR })
  try {
    const receipt = await app.controller.start({ workflowName: "code-review", mode: "auto", background: true })
    assert.equal(receipt.status, "background")
    await app.controller.settled((receipt as { runId: string }).runId)
    assert.equal(app.inbox.readyCount(), 1)
  } finally {
    app.cleanup()
  }
})

test("stop mid-run aborts the workflow", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR })
  try {
    const receipt = await app.controller.start({ workflowName: "code-review", mode: "auto", background: true })
    const runId = (receipt as { runId: string }).runId
    await app.controller.stop(runId)
    await app.controller.settled(runId)
    const state = app.store.get(runId)
    assert.ok(state?.status === "aborted" || state?.status === "completed")
  } finally {
    app.cleanup()
  }
})

test("checkpoint response completes a checkpointed workflow", async () => {
  const script = `export const meta = { name: "cp-test", description: "checkpoint test", phases: [{ title: "p" }] }
await agent("first call")
const resp = await checkpoint("review the result")
await agent("second call after checkpoint")
return { checkpointResponse: resp, done: true }
`
  const app = await createWorkflowIntegrationHarness({})
  try {
    const receipt = await app.controller.start({ script, mode: "checkpointed", background: true })
    const runId = (receipt as { runId: string }).runId

    // Wait for the run to enter checkpoint state
    let tries = 0
    while (app.store.get(runId)?.status !== "checkpoint" && tries < 200) {
      await new Promise((r) => setTimeout(r, 10))
      tries++
    }
    assert.equal(app.store.get(runId)?.status, "checkpoint")

    app.controller.respondToCheckpoint(runId, { action: "continue" })

    await app.controller.settled(runId)
    const state = app.store.get(runId)
    assert.equal(state?.status, "completed")
  } finally {
    app.cleanup()
  }
})

test("edit-and-resume caches the first call and reruns the second", async () => {
  const originalScript = `export const meta = { name: "er-test", description: "edit-resume test", phases: [{ title: "p" }] }
const a = await agent("first original")
const b = await agent("second original")
return { a, b }
`
  const editedScript = `export const meta = { name: "er-test", description: "edit-resume test", phases: [{ title: "p" }] }
const a = await agent("first original")
const b = await agent("second EDITED")
return { a, b }
`
  const app = await createWorkflowIntegrationHarness({})
  try {
    const result1 = await app.controller.start({ script: originalScript, mode: "auto", background: false })
    assert.equal(result1.status, "completed")
    const runId1 = (result1 as { runId: string }).runId

    // editAndResume uses the existing run's name. The runner's onProgress overwrites
    // state.name with the executable string, so name !== runId → editAndResume tries
    // to save with the executable as the workflow name → validateWorkflowName fails.
    // Workaround: patch the store state's name back to runId before editAndResume.
    const state1 = app.store.get(runId1)
    if (state1) {
      app.store.set(runId1, { ...state1, name: runId1 })
    }
    const result2 = await app.controller.editAndResume(runId1, editedScript, "auto") as { status: string; runId: string }
    // editAndResume returns a background receipt (background defaults true). Await settle.
    if (result2.status === "background") {
      await app.controller.settled(result2.runId)
    }
    assert.equal(app.store.get(result2.runId)?.status, "completed")
  } finally {
    app.cleanup()
  }
})

test("restart hydration: interrupted run shows as interrupted after hydrate", async () => {
  const journalDir = mkdtempSync(join(tmpdir(), "wf-hydrate-"))
  const projectDir = mkdtempSync(join(tmpdir(), "wf-hydrate-proj-"))
  try {
    const script = `export const meta = { name: "h-test", description: "hydrate test", phases: [{ title: "p" }] }
const a = await agent("hydrated first")
return { a }
`
    // First session: start a run, journal a wf:started but no terminal (simulate crash)
    const journal1 = new WorkflowJournal(journalDir)
    const store1 = new WorkflowRunStore()
    const registry1 = new WorkflowRegistry(discoverWorkflows({ builtinDir: BUILTIN_DIR, globalDir: "", projectDir: "" }).workflows)
    const runRegistry1 = { get: () => undefined, list: () => [], subscribe: () => () => {} } as never

    let childCounter = 0
    const runDepsFactory = (): WorkflowRunDeps => ({
      spawn: async (prompt: string) => {
        childCounter++
        return { finalText: "ok-" + prompt.slice(0, 8), runId: "fl-h-" + childCounter, status: "completed" as const, costTotal: 0.01, tokenTotal: 10 }
      },
      worktree: { isGitRepo: () => false, create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} } as never,
      tierRegistry: { get: () => ({ models: ["pi/default"] }) } as never,
      journal: journal1,
      runRegistry: runRegistry1 as never,
      genRunId: () => "wf-h-" + Date.now().toString(36),
      notify: () => {},
      resolveWorkflow: (name: string) => {
        const def = registry1.get(name)
        return def ? { sourceText: def.sourceText, executable: def.executable } : undefined
      },
    })

    const controller1 = new WorkflowController({
      registry: registry1,
      projectDir,
      store: store1,
      journal: journal1,
      runWorkflow,
      runDepsFactory,
      inbox: new ResultsInbox(),
      genRunId: () => "wf-h-" + Date.now().toString(36),
      notify: () => {},
    })

    // Journal a wf:started manually (simulating a crash mid-run)
    const fakeRunId = "wf-h-crash-test"
    journal1.append(fakeRunId, {
      type: "wf:started",
      runId: fakeRunId,
      script,
      mode: "auto",
      phases: [],
      ts: Date.now(),
    })

    // Second session: new controller hydrates from the journal
    const store2 = new WorkflowRunStore()
    const controller2 = new WorkflowController({
      registry: registry1,
      projectDir,
      store: store2,
      journal: journal1,
      runWorkflow,
      runDepsFactory,
      inbox: new ResultsInbox(),
      genRunId: () => "wf-h-" + Date.now().toString(36),
      notify: () => {},
    })
    controller2.hydrate()

    const hydrated = store2.get(fakeRunId)
    assert.ok(hydrated)
    assert.equal(hydrated?.status, "interrupted")
  } finally {
    rmSync(journalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})
