import { test } from "node:test";
import assert from "node:assert/strict";
import { PauseGate } from "../src/workflows/runtime/pause-gate.ts";

test("PauseGate blocks new work, resumes all waiters, and stop rejects them", async () => {
  const gate = new PauseGate();
  gate.pause();
  let released = false;
  const waiting = gate.wait(new AbortController().signal).then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  gate.resume();
  await waiting;
  assert.equal(released, true);

  gate.pause();
  const aborter = new AbortController();
  const stopped = gate.wait(aborter.signal);
  aborter.abort(new Error("workflow stopped"));
  await assert.rejects(stopped, /workflow stopped/);
});
