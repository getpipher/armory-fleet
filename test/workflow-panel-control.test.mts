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
  // Navigate to the run row via Down-arrow keyboard nav (the #27 fix makes this work;
  // previously the Workflows view swallowed non-action keys before they reached the list).
  panel.handleInput("\x1b[B")  // Down arrow → definition (idx 0) to run (idx 1)
  panel.handleInput("u")
  assert.deepEqual(controller.calls, [["resume", "wf-1"]])
  panel.handleInput("x")
  assert.deepEqual(controller.calls.at(-1), ["stop", "wf-1"])
})

test("Workflows tab: Down arrow moves selection off the first row (#27)", () => {
  // Repro for #27: the Workflows view intercepted every key and returned early on non-action
  // keys, so Down/Up never reached the SelectList and the → cursor was stuck on row 0.
  // With the fix, non-action keys are forwarded to this.list.handleInput(data).
  const { panel } = panelFixture({ selected: runningRun() })
  openWorkflows(panel)
  const list = (panel as unknown as {
    list: { getSelectedItem: () => { value: string }; setSelectedIndex: (n: number) => void }
  }).list
  // Row 0 = definition:code-review, row 1 = run:wf-1
  assert.equal(list.getSelectedItem().value, "definition:code-review")
  panel.handleInput("\x1b[B")  // Down arrow
  assert.equal(list.getSelectedItem().value, "run:wf-1", "Down arrow should move cursor to the run row")
  panel.handleInput("\x1b[B")  // Down arrow wraps to top (only 2 rows)
  assert.equal(list.getSelectedItem().value, "definition:code-review", "Down arrow should wrap back to the definition")
  panel.handleInput("\x1b[A")  // Up arrow back to run
  assert.equal(list.getSelectedItem().value, "run:wf-1", "Up arrow should move cursor back to the run row")
})

test("Workflows tab: action keys still fire on the selected row after navigating (#27)", () => {
  // Guard against the #27 fix regressing action-key dispatch: after moving the cursor with
  // Down, the action key must operate on the *newly-selected* row, not the original one.
  const { panel, controller } = panelFixture({ selected: pausedRun() })
  openWorkflows(panel)
  panel.handleInput("\x1b[B")  // Down → run row (paused run)
  panel.handleInput("x")        // stop on the run
  assert.deepEqual(controller.calls.at(-1), ["stop", "wf-1"], "action fires on the navigated-to row")
})

test("Workflows tab: non-navigation non-action key does not move selection or fire actions", () => {
  // A bare letter that is neither a nav key nor a workflow action (e.g. 'z') should be a no-op:
  // selection stays put and no controller call is made.
  const { panel, controller } = panelFixture({ selected: runningRun() })
  openWorkflows(panel)
  const before = (panel as unknown as { list: { getSelectedItem: () => { value: string } } }).list.getSelectedItem().value
  panel.handleInput("z")
  assert.equal((panel as unknown as { list: { getSelectedItem: () => { value: string } } }).list.getSelectedItem().value, before)
  assert.equal(controller.calls.length, 0)
})

test("#27: empty Workflows list (no definitions, no runs) — nav keys are a safe no-op, not a crash", () => {
  // The reviewer-flagged edge case: when the Workflows list is empty, getSelectedItem() returns
  // null. The fix classifies the key first and forwards nav keys to the list BEFORE the sel
  // check, so Down/Up still reach the (empty) SelectList (a no-op) instead of being swallowed
  // by an `if (!sel) return` at the top — and an action key on an empty list is a safe no-op.
  const { panel, controller } = panelFixture({ definitions: [] })
  openWorkflows(panel)
  const list = (panel as unknown as { list: { getSelectedItem: () => { value: string } | null } }).list
  assert.equal(list.getSelectedItem(), null, "empty list has no selected item")
  // nav keys: safe no-op, no throw
  assert.doesNotThrow(() => panel.handleInput("\x1b[B"))
  assert.doesNotThrow(() => panel.handleInput("\x1b[A"))
  assert.equal(list.getSelectedItem(), null, "nav on empty list stays null")
  // action key on empty list: safe no-op, no controller call
  assert.doesNotThrow(() => panel.handleInput("r"))
  assert.equal(controller.calls.length, 0)
})

test("closing panel unsubscribes workflow store", () => {
  const { panel, store, renderCount } = panelFixture()
  openWorkflows(panel)
  panel.handleInput("q")
  const renders = renderCount()
  store.set("wf-1", runningRun())
  assert.equal(renderCount(), renders)
})
