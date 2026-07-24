// test/results-inbox.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultsInbox, type RunResult } from "../src/runtime/results-inbox.ts";

function result(runId: string, task: string): RunResult {
  return { runId, task, status: "completed", summary: "s", paths: ["a.md"], branch: `fleet/${runId}`, completedAt: 1 };
}

test("push + pull(runId) returns that result and marks it delivered", () => {
  const inbox = new ResultsInbox();
  inbox.push(result("fl-1", "t1"));
  const r = inbox.pull("fl-1");
  assert.equal(r.length, 1);
  assert.equal(r[0]!.runId, "fl-1");
  assert.equal(inbox.readyCount(), 0);
});

test("pull() with no arg returns all ready + marks them delivered; a second pull returns empty", () => {
  const inbox = new ResultsInbox();
  inbox.push(result("fl-2", "t2"));
  inbox.push(result("fl-3", "t3"));
  const r = inbox.pull();
  assert.equal(r.length, 2);
  assert.equal(inbox.pull().length, 0);
});

test("readyCount + renderHint reflect ready (undelivered) results", () => {
  const inbox = new ResultsInbox();
  assert.equal(inbox.renderHint(), "");
  inbox.push(result("fl-4", "t4"));
  inbox.push(result("fl-5", "t5"));
  assert.equal(inbox.readyCount(), 2);
  assert.match(inbox.renderHint(), /2 fleet results ready/);
});

test("renderHint caps at 5 (6+ collapses to '5+ fleet results ready')", () => {
  const inbox = new ResultsInbox();
  for (let i = 0; i < 7; i++) inbox.push(result(`fl-${i}`, `t${i}`));
  assert.match(inbox.renderHint(), /5\+ fleet results ready/);
});

test("pull(runId) for a result that was already delivered returns empty", () => {
  const inbox = new ResultsInbox();
  inbox.push(result("fl-6", "t6"));
  inbox.pull();
  assert.equal(inbox.pull("fl-6").length, 0);
});