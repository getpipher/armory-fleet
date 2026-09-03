// test/transcript-findings.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingLines, findingsFromRuns } from "../src/transcript/findings.ts";

test("findings: completed rows carry numbers; failed rows carry — honesty", () => {
  const lines = findingLines([
    { status: "completed", agent: "reviewer", dur: "4m12s", tok: "598K tok", cost: "$0.30", note: "Ship" },
    { status: "failed", agent: "scheduler", note: "worker exited without result", warn: true },
  ]);
  assert.ok(lines[0]!.includes("findings"), "header line first");
  assert.ok(lines[1]!.includes("✓ reviewer"));   // rows start after the header
  assert.ok(lines[1]!.includes("$0.30"));
  assert.ok(lines[2]!.includes("✗ scheduler"));
  assert.ok(lines[2]!.includes("—"));
  assert.ok(lines[2]!.includes("⚠"));
});

test("findingsFromRuns: completed rows carry numbers; failed rows carry — cells", () => {
  const rows = findingsFromRuns([
    { runId: "a", agent: "reviewer", model: "m", task: "t", status: "completed", startedAt: 0, endedAt: 252_000, contextTokens: 598_000, costTotal: 0.3, resultSummary: "Ship" },
    { runId: "b", agent: "scheduler", model: "m", task: "t", status: "failed", startedAt: 0, endedAt: 5_000, error: "boom" },
  ]);
  assert.equal(rows[0]!.agent, "reviewer");
  assert.equal(rows[0]!.dur, "4m12s"); // endedAt − startedAt, replay-safe
  assert.equal(rows[0]!.cost, "$0.30");
  assert.equal(rows[0]!.note, "Ship");
  assert.equal(rows[1]!.agent, "scheduler");
  assert.equal(rows[1]!.dur, undefined, "failed rows carry no numbers");
  assert.equal(rows[1]!.tok, undefined);
  assert.equal(rows[1]!.cost, undefined);
  assert.equal(rows[1]!.note, "boom");
  assert.equal(rows[1]!.warn, true);
  const lines = findingLines(rows);
  assert.ok(lines[1]!.includes("✓ reviewer"), "completed row after header");
  assert.ok(lines[2]!.includes("✗ scheduler"));
  assert.ok(lines[2]!.includes("—"));
});
