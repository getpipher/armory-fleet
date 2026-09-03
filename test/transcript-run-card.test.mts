// test/transcript-run-card.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCardLines, finalLine } from "../src/transcript/run-card.ts";

const base = {
  runId: "fl-x", agent: "reviewer", model: "glm", task: "Review PR #102",
  status: "running" as const, startedAt: 0, turnCount: 3,
  lastEventClass: "tool:read", contextTokens: 186_000, maxContext: 1_000_000,
};

test("live card frames with spinner, agent, clock, state line", () => {
  const lines = liveCardLines({ ...base } as never, 41_000, 0, 80);
  assert.equal(lines.length, 4);                       // top / task / state / bottom
  assert.ok(lines[0]!.includes("⣾"));
  assert.ok(lines[0]!.includes("reviewer"));
  assert.ok(lines[1]!.includes("Review PR #102"));
  assert.ok(lines[2]!.includes("turn 3"));
  assert.ok(lines[2]!.includes("41s"));
  assert.ok(lines[2]!.includes("19%"));                  // 186K/1M
});

test("final line completed shows money and files; failed shows — honesty", () => {
  const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
  const ok = finalLine({ ...base, status: "completed", costTotal: 0.3, filesTouched: 3, resultSummary: "Ship", endedAt: 252_000 } as never, theme as never);
  assert.ok(ok.includes("✓ reviewer"));
  assert.ok(ok.includes("$0.30"));
  assert.ok(ok.includes("✎3"));
  assert.ok(ok.includes("4m12s"));                      // endedAt - startedAt, replay-safe
  const bad = finalLine({ ...base, status: "failed", error: "boom" } as never, theme as never);
  assert.ok(bad.includes("✗ reviewer"));
  assert.ok(bad.includes("—"));
  assert.ok(bad.includes("boom"));
});
