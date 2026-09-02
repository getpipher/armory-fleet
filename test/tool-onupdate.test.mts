// test/tool-onupdate.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardSnapshot } from "../src/transcript/card-state.ts";

const run = {
  runId: "fl-x", agent: "reviewer", model: "glm", task: "t", track: true, todoId: null,
  status: "running", startedAt: 1000, cwd: "/c", backend: "pi",
  turnCount: 3, lastEventClass: "tool:read", contextTokens: 1000, costTotal: 0.5,
} as never;

test("cardSnapshot maps RunRecord → RunCardState", () => {
  const s = cardSnapshot(run);
  assert.equal(s.runId, "fl-x");
  assert.equal(s.status, "running");
  assert.equal(s.turnCount, 3);
  assert.equal(s.lastEventClass, "tool:read");
});

test("cardSnapshot merges overrides (final status, warnings)", () => {
  const s = cardSnapshot(run, { status: "failed", error: "boom", warnings: ["zero-tool"] });
  assert.equal(s.status, "failed");
  assert.equal(s.error, "boom");
  assert.deepEqual(s.warnings, ["zero-tool"]);
});
