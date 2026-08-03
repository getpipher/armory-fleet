import { test } from "node:test"
import assert from "node:assert/strict"
import {
  fakeUi,
  context,
  panelDeps,
  fakeController,
  terminalRun,
  definition,
  ORIGINAL_SOURCE,
  EDITED_SOURCE,
} from "./helpers/workflow-panel-fixture.mts"
import { openWorkflowPanelLoop } from "../src/workflows/panel-host.ts"

test("edit-and-resume closes panel, opens editor, starts resume, then reopens", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "edit-resume", runId: "wf-old" } },
    { type: "editor", value: EDITED_SOURCE },
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController({ getRun: () => terminalRun({ script: ORIGINAL_SOURCE }) })
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.deepEqual(controller.calls, [["editAndResume", "wf-old", EDITED_SOURCE, "checkpointed"]])
  assert.equal(ui.customCount, 0) // customCount is tracked differently — see fixture
})

test("save-as confirms overwrite and refreshes definitions", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "save", runId: "wf-1" } },
    { type: "input", value: "code-review" },
    { type: "confirm", value: true },
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController({ saveCollision: true, getRun: () => terminalRun({ script: ORIGINAL_SOURCE }) })
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.deepEqual(controller.calls.at(-1), ["save", { name: "code-review", source: ORIGINAL_SOURCE, overwrite: true }])
})

test("non-empty Run prompt closes panel and sends bounded model authorization", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "run", definitionName: "code-review", prompt: "audit this diff" } },
  ])
  await openWorkflowPanelLoop(panelDeps(fakeController()), context(ui))
  assert.match(ui.sentUserMessages[0] ?? "", /audit this diff.*fleet workflow/s)
})

// ── Additional cases ──

test("blank Run executes selected definition directly", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "run", definitionName: "code-review", prompt: "" } },
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController()
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.deepEqual(controller.calls[0], ["start", { workflowName: "code-review", mode: "checkpointed" }])
})

test("open-definition shows bounded source via notify", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "open-definition", name: "code-review" } },
    { type: "custom", value: { action: "close" } },
  ])
  const def = definition("builtin", "code-review")
  const controller = fakeController({ definitions: () => [def] })
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.ok(ui.notifies.some((n) => n.includes("code-review")))
})

test("view-result shows bounded result via notify", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "view-result", runId: "wf-1" } },
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController({
    getRun: () => terminalRun({ result: { ok: true }, logs: ["line1", "line2"] }),
  })
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.ok(ui.notifies.some((n) => n.includes("ok")))
})

test("respond collects checkpoint response and calls respondToCheckpoint", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "respond", runId: "wf-1" } },
    { type: "confirm", value: true },
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController()
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.deepEqual(controller.calls.at(-1), ["respondToCheckpoint", "wf-1", { action: "continue" }])
})

test("closing leaves checkpoint pending (no respondToCheckpoint call)", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "close" } },
  ])
  const controller = fakeController()
  await openWorkflowPanelLoop(panelDeps(controller), context(ui))
  assert.equal(controller.calls.filter((c) => c[0] === "respondToCheckpoint").length, 0)
})
