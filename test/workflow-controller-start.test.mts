import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkflowRunResult } from "../src/workflows/runner.ts"
import {
  controllerFixture,
  completed,
  PROJECT_SOURCE,
  UPDATED_SOURCE,
} from "./helpers/workflow-controller-fixture.mts"

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test("background is default, returns immediately, then updates store and inbox", async () => {
  const deferredRun = deferred<WorkflowRunResult>()
  const { controller, store, inbox } = controllerFixture({
    runWorkflow: async () => deferredRun.promise,
  })
  const receipt = await controller.start({ workflowName: "demo", mode: "auto" })
  assert.deepEqual(receipt, { runId: "wf-1", status: "background" })
  assert.equal(store.get("wf-1")?.status, "running")
  deferredRun.resolve({
    runId: "wf-1",
    status: "completed",
    result: { ok: true },
    phases: [],
    childRunIds: [],
    logs: [],
    tokenTotal: 4,
    costTotal: 0.2,
  })
  await controller.settled("wf-1")
  assert.equal(store.get("wf-1")?.status, "completed")
  assert.equal(inbox.readyCount(), 1)
})

test("foreground awaits and script/name validation leaves no ghost row", async () => {
  const { controller, store } = controllerFixture()
  const result = await controller.start({ script: "return 1", mode: "auto", background: false })
  assert.equal(result.status, "completed")
  await assert.rejects(
    () => controller.start({ script: "return 1", workflowName: "demo", mode: "auto" }),
    /exactly one/,
  )
  assert.equal([...store.values()].length, 1)
})

test("script plus name saves before dispatch and refreshes project shadow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-save-"))
  const { controller, registry, cleanup } = controllerFixture({ projectDir: dir })
  try {
    await controller.start({
      script: PROJECT_SOURCE,
      name: "code-review",
      mode: "auto",
      background: false,
    })
    assert.equal(registry.get("code-review")?.source, "project")
    await assert.rejects(
      () =>
        controller.start({
          script: PROJECT_SOURCE,
          name: "code-review",
          mode: "auto",
          background: false,
        }),
      /overwrite:true/,
    )
  } finally {
    cleanup()
  }
})

test("definition-by-name executes normalized executable and unknown names are actionable", async () => {
  const seen: string[] = []
  const { controller } = controllerFixture({
    runWorkflow: async (_unused, opts) => {
      seen.push(opts.script)
      return completed(opts.runId!)
    },
  })
  await controller.start({ workflowName: "demo", mode: "auto", background: false })
  assert.match(seen[0]!, /^module\.exports = \(async/)
  await assert.rejects(
    () => controller.start({ workflowName: "missing", mode: "auto" }),
    /missing.*available: demo/,
  )
})
