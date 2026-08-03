import { test } from "node:test"
import assert from "node:assert/strict"
import {
  controllerFixture,
  child,
  TWO_AGENTS,
  ONE_AGENT,
  CHECKPOINT_SCRIPT,
  waitFor,
} from "./helpers/workflow-controller-fixture.mts"

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test("pause is cooperative and resume releases the next dispatch", async () => {
  const first = deferred<void>()
  const secondStarted = deferred<void>()
  let calls = 0
  const { controller } = controllerFixture({ spawn: async () => {
    calls++
    if (calls === 1) await first.promise
    if (calls === 2) secondStarted.resolve()
    return child(`fl-${calls}`)
  }})
  const receipt = await controller.start({ script: TWO_AGENTS, mode: "auto" })
  controller.pause(receipt.runId)
  first.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  await controller.resume(receipt.runId)
  await secondStarted.promise
  assert.equal(calls, 2)
})

test("stop aborts active children and writes one abort terminal", async () => {
  const { controller, journal } = controllerFixture({ spawn: async (_p, opts) => {
    await new Promise((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true }))
    return child("never")
  }})
  const receipt = await controller.start({ script: ONE_AGENT, mode: "auto" })
  await controller.stop(receipt.runId)
  assert.equal(controller.getRun(receipt.runId)?.status, "aborted")
  assert.equal(journal.replay(receipt.runId).filter((e) => e.type === "wf:aborted").length, 1)
})

test("checkpoint stays pending until response and invalid transitions are actionable", async () => {
  const { controller } = controllerFixture({ spawn: async () => child("ok") })
  const receipt = await controller.start({ script: CHECKPOINT_SCRIPT, mode: "checkpointed" })
  await waitFor(() => controller.getRun(receipt.runId)?.status === "checkpoint")
  assert.match(controller.getRun(receipt.runId)?.checkpoint?.prompt ?? "", /approve/)
  controller.respondToCheckpoint(receipt.runId, true)
  await controller.settled(receipt.runId)
  assert.equal(controller.getRun(receipt.runId)?.status, "completed")
  assert.throws(() => controller.pause(receipt.runId), /cannot pause.*completed/)
})
