import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/workflows/runner.ts";
import type { WorkflowProgressEvent } from "../src/workflows/runtime/types.ts";
import { deps, cleanup, child } from "./helpers/workflow-runner-fixture.mts";

test("runner waits before each dispatch and emits phase/terminal progress", async () => {
  const events: WorkflowProgressEvent[] = [];
  let waits = 0;
  const d = deps({
    runtime: {
      signal: new AbortController().signal,
      waitIfPaused: async () => { waits++; },
      onProgress: (e) => events.push(e),
    },
  });
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => { phase('Scan'); await agent('a'); await agent('b'); return 1 })()",
      mode: "auto",
    }, d);
    assert.equal(result.status, "completed");
    assert.equal(waits, 2);
    assert.ok(events.some((e) => e.kind === "phase" && e.snapshot.currentPhase === "Scan"));
    assert.equal(events.at(-1)?.kind, "completed");
  } finally { cleanup(d); }
});

test("log emits a bounded visible progress snapshot", async () => {
  const events: WorkflowProgressEvent[] = [];
  const d = deps({ runtime: { signal: new AbortController().signal, waitIfPaused: async () => {}, onProgress: (e) => events.push(e) } });
  try {
    const result = await runWorkflow("x", { script: "module.exports = (async () => { log('scanning routes'); return 1 })()", mode: "auto" }, d);
    assert.deepEqual(result.logs, ["scanning routes"]);
    assert.ok(events.some((e) => e.kind === "log" && e.snapshot.logs.at(-1) === "scanning routes"));
  } finally { cleanup(d); }
});

test("runner abort wins over a late child completion", async () => {
  const aborter = new AbortController();
  const d = deps({
    spawn: async () => { aborter.abort(new Error("workflow stopped")); return child("late"); },
    runtime: { signal: aborter.signal, waitIfPaused: async () => {}, onProgress: () => {} },
  });
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => await agent('a'))()", mode: "auto",
    }, d);
    assert.equal(result.status, "aborted");
    assert.match(result.error ?? "", /workflow stopped/);
    const terminal = d.journal.replay(result.runId).filter((e) => e.type === "wf:aborted" || e.type === "wf:completed");
    assert.deepEqual(terminal.map((e) => e.type), ["wf:aborted"]);
  } finally { cleanup(d); }
});
