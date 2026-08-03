import { test } from "node:test"
import assert from "node:assert/strict"
import {
  panelFixture,
  openWorkflows,
  stripAnsi,
  runningRun,
  pausedRun,
} from "./helpers/workflow-panel-fixture.mts"

test("Workflows tab renders definitions before runs and refreshes on store mutation", () => {
  const { panel, store } = panelFixture()
  for (let i = 0; i < 7; i++) panel.handleInput("\t")
  assert.match(stripAnsi(panel.render(120).join("\n")), /code-review.*builtin/)
  store.set("wf-1", runningRun())
  assert.match(stripAnsi(panel.render(120).join("\n")), /wf-1.*running/)
})

test("pause resume stop keys call controller for selected run", () => {
  const { panel, controller } = panelFixture({ selected: pausedRun() })
  openWorkflows(panel)
  // Navigate to the run row (definitions come first, so down-arrow once)
  // Use the SelectList's setSelectedIndex directly via the panel's internal list
  const list = (panel as unknown as { list: { setSelectedIndex: (n: number) => void } }).list
  list.setSelectedIndex(1)  // index 0 = definition, index 1 = run
  panel.handleInput("u")
  assert.deepEqual(controller.calls, [["resume", "wf-1"]])
  panel.handleInput("x")
  assert.deepEqual(controller.calls.at(-1), ["stop", "wf-1"])
})

test("closing panel unsubscribes workflow store", () => {
  const { panel, store, renderCount } = panelFixture()
  openWorkflows(panel)
  panel.handleInput("q")
  const renders = renderCount()
  store.set("wf-1", runningRun())
  assert.equal(renderCount(), renders)
})
