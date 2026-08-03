import { test } from "node:test"
import assert from "node:assert/strict"
import {
  controllerFixture,
  SOURCE,
  started,
  progress,
  completedEvent,
} from "./helpers/workflow-controller-fixture.mts"

test("hydrate restores terminal and interrupted rows; resume unchanged reuses original source", async () => {
  const { controller, journal, store } = controllerFixture()
  journal.append("wf-done", started("wf-done", SOURCE))
  journal.append("wf-done", completedEvent("wf-done", "ok"))
  journal.append("wf-cut", started("wf-cut", SOURCE))
  journal.append("wf-cut", progress("wf-cut", "running"))
  controller.hydrate()
  assert.equal(store.get("wf-done")?.status, "completed")
  assert.equal(store.get("wf-cut")?.status, "interrupted")
  const receipt = await controller.resume("wf-cut")
  assert.equal(receipt.status, "background")
  assert.equal(controller.getRun(receipt.runId)?.resumeFromRunId, "wf-cut")
})

test("stop on interrupted journals abort without creating a live controller", async () => {
  const { controller, journal, store } = controllerFixture()
  journal.append("wf-cut", started("wf-cut", SOURCE))
  controller.hydrate()
  await controller.stop("wf-cut")
  assert.equal(store.get("wf-cut")?.status, "aborted")
  assert.equal(journal.replay("wf-cut").filter((e) => e.type === "wf:aborted").length, 1)
})
