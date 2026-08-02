import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowsItems } from "../src/workflows/panel/workflows-items.ts";

test("buildWorkflowsItems: empty list → empty items", () => {
  assert.deepEqual(buildWorkflowsItems([]), []);
});

test("buildWorkflowsItems: renders status glyph + phase strip + agent counts", () => {
  const items = buildWorkflowsItems([
    { runId: "wf-a", name: "auth_audit", status: "running", currentPhase: "Scan", phases: [{ title: "Scan" }, { title: "Review" }, { title: "Verify" }], agents: 3, cached: 1, reRun: 2, tokens: 4200, cost: 0.03 },
  ]);
  assert.equal(items.length, 1);
  const label = items[0]!.label as string;
  assert.match(label, /▶/);            // running glyph
  assert.match(label, /auth_audit/);
  assert.match(label, /Scan/);
  assert.match(label, /3/);            // agent count
});

test("buildWorkflowsItems: completed run shows ✓ glyph", () => {
  const items = buildWorkflowsItems([{ runId: "wf-b", name: "code-review", status: "completed", currentPhase: "Verify", phases: [{ title: "Scan" }, { title: "Verify" }], agents: 5, cached: 5, reRun: 0, tokens: 8000, cost: 0.06 }]);
  assert.match(items[0]!.label as string, /✓/);
});

test("buildWorkflowsItems: aborted run shows ✗ glyph", () => {
  const items = buildWorkflowsItems([{ runId: "wf-c", name: "x", status: "aborted", currentPhase: "", phases: [], agents: 1, cached: 0, reRun: 1, tokens: 100, cost: 0 }]);
  assert.match(items[0]!.label as string, /✗/);
});
