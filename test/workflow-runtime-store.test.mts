import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRunStore } from "../src/workflows/runtime/run-store.ts";
import type { WorkflowRunState } from "../src/workflows/runtime/types.ts";

function row(status: WorkflowRunState["status"] = "queued"): WorkflowRunState {
  return {
    runId: "wf-1", name: "demo", script: "return 1", mode: "auto", status, startedAt: 1,
    currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0,
  };
}

test("WorkflowRunStore emits once per set and unsubscribe stops delivery", () => {
  const store = new WorkflowRunStore();
  const seen: string[] = [];
  const off = store.subscribe((runId) => seen.push(runId));
  store.set("wf-1", row());
  off();
  store.set("wf-1", row("running"));
  assert.deepEqual(seen, ["wf-1"]);
  assert.equal(store.get("wf-1")?.status, "running");
  assert.equal([...store.values()].length, 1);
});
