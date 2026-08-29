// test/store-subscribe.test.mts — SPEC-6-4 Task 1: RunLog/RunJournal subscribe fan-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, type RunLogEvent } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";

test("RunLog.subscribe fires on append with (runId, event), in append order", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runlog-sub-"));
  try {
    const log = new RunLog(join(dir, "conversations"));
    const seen: Array<{ runId: string; event: RunLogEvent }> = [];
    const unsub = log.subscribe((runId, event) => seen.push({ runId, event }));
    log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "scout", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
    log.append("fl-1", { type: "message", role: "assistant", text: "hi", turnIndex: 0 });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.runId, "fl-1");
    assert.equal(seen[0]!.event.type, "run:meta");
    assert.equal(seen[1]!.event.type, "message");
    unsub();
    log.append("fl-1", { type: "message", role: "assistant", text: "gone", turnIndex: 1 });
    assert.equal(seen.length, 2, "unsubscribed listener must not fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunLog.append survives a throwing subscriber (event still persisted, others still notified)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runlog-thrown-"));
  try {
    const log = new RunLog(join(dir, "conversations"));
    let good = 0;
    log.subscribe(() => { throw new Error("listener boom"); });
    log.subscribe(() => { good++; });
    log.append("fl-1", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
    assert.equal(good, 1, "second subscriber still fires after the first threw");
    assert.equal(log.replay("fl-1").length, 1, "event still persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal.subscribe fires on append with (runId, event)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-journal-sub-"));
  try {
    const journal = new RunJournal(join(dir, "runs"));
    const seen: Array<{ runId: string; type: string }> = [];
    const unsub = journal.subscribe((runId, event) => seen.push({ runId, type: event.type }));
    journal.append("fl-2", { type: "run:started", runId: "fl-2", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
    journal.append("fl-2", { type: "phase:started", phase: "impl", ts: 2 });
    assert.deepEqual(seen, [
      { runId: "fl-2", type: "run:started" },
      { runId: "fl-2", type: "phase:started" },
    ]);
    unsub();
    journal.append("fl-2", { type: "phase:completed", phase: "impl", summary: "s", paths: [], ts: 3 });
    assert.equal(seen.length, 2, "unsubscribed listener must not fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
