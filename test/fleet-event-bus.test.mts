// test/fleet-event-bus.test.mts — SPEC-6-4 Task 3: the frozen fleet:* taxonomy.
// These assertions pin channel names + payload shapes VERBATIM (spec §3.1). A rename or
// reshaping must break this file loudly — that is the point (frozen surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { FleetEventBus, type FleetChannel, type FleetEnvelope } from "../src/rpc/event-bus.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bus-"));
  const runLog = new RunLog(join(dir, "conversations"));
  const journal = new RunJournal(join(dir, "runs"));
  const emitted: Array<{ channel: FleetChannel; payload: FleetEnvelope }> = [];
  const bus = new FleetEventBus({
    runLog, journal,
    emit: (channel, payload) => emitted.push({ channel, payload }),
  });
  return { dir, runLog, journal, emitted, bus };
}

test("run:meta → fleet:run:started with the frozen payload shape (incl. mode default)", () => {
  const h = harness();
  try {
    h.runLog.append("fl-a", { type: "run:meta", runId: "fl-a", agent: "scout", model: "Test/m", task: "do it", startedAt: 1000, track: true, todoId: null });
    assert.equal(h.emitted.length, 1);
    const { channel, payload } = h.emitted[0]!;
    assert.equal(channel, "fleet:run:started");
    assert.equal(payload.runId, "fl-a");
    assert.equal(payload.seq, 1);
    assert.equal(typeof payload.ts, "number");
    assert.deepEqual(
      { agent: payload.agent, model: payload.model, cwd: payload.cwd, sessionCwd: payload.sessionCwd, mode: payload.mode, task: payload.task },
      { agent: "scout", model: "Test/m", cwd: undefined, sessionCwd: undefined, mode: "foreground", task: "do it" },
    );
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("message/tool appends → fleet:child:* with journal-excerpted fields, seq continues per run", () => {
  const h = harness();
  try {
    h.runLog.append("fl-b", { type: "message", role: "assistant", text: "hello", turnIndex: 0 });
    h.runLog.append("fl-b", { type: "tool", toolName: "edit", args: '{"path":"a.ts"}', result: "ok", isError: false, turnIndex: 0 });
    assert.equal(h.emitted.length, 2);
    assert.equal(h.emitted[0]!.channel, "fleet:child:message");
    assert.deepEqual({ role: h.emitted[0]!.payload.role, text: h.emitted[0]!.payload.text }, { role: "assistant", text: "hello" });
    assert.equal(h.emitted[1]!.channel, "fleet:child:tool");
    assert.deepEqual(
      { toolName: h.emitted[1]!.payload.toolName, args: h.emitted[1]!.payload.args, result: h.emitted[1]!.payload.result, isError: h.emitted[1]!.payload.isError },
      { toolName: "edit", args: '{"path":"a.ts"}', result: "ok", isError: false },
    );
    assert.equal(h.emitted[0]!.payload.seq, 1);
    assert.equal(h.emitted[1]!.payload.seq, 2, "seq is per-run monotonic across child events");
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("run:ended → fleet:run:ended with status/error/filesTouched/toolCallCount/durationMs", () => {
  const h = harness();
  try {
    h.runLog.append("fl-c", { type: "run:meta", runId: "fl-c", agent: "scout", model: "m", task: "t", startedAt: 1000, track: true, todoId: null });
    h.runLog.append("fl-c", { type: "run:ended", runId: "fl-c", status: "failed", endedAt: 2500, tokenTotal: 10, error: "model 404", toolCallCount: 0, filesTouched: [] });
    const last = h.emitted[h.emitted.length - 1]!;
    assert.equal(last.channel, "fleet:run:ended");
    assert.equal(last.payload.status, "failed");
    assert.equal(last.payload.error, "model 404");
    assert.deepEqual(last.payload.filesTouched, []);
    assert.equal(last.payload.toolCallCount, 0);
    assert.equal(last.payload.durationMs, 1500, "durationMs = endedAt - run:meta.startedAt");
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("journal phase events → fleet:phase:* in their own seq space; non-phase journal events stay internal", () => {
  const h = harness();
  try {
    h.journal.append("fl-d", { type: "run:started", runId: "fl-d", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
    h.journal.append("fl-d", { type: "phase:started", phase: "impl", ts: 2 });
    h.journal.append("fl-d", { type: "phase:completed", phase: "impl", summary: "did", paths: ["a.ts"], ts: 3 });
    h.journal.append("fl-d", { type: "phase:failed", phase: "review", error: "nits", ts: 4 });
    h.journal.append("fl-d", { type: "run:completed", runId: "fl-d", ts: 5 });
    const channels = h.emitted.map((e) => e.channel);
    assert.deepEqual(channels, ["fleet:phase:started", "fleet:phase:completed", "fleet:phase:failed"],
      "run:started/completed journal events are NOT published (run-level comes from RunLog)");
    assert.deepEqual(h.emitted[0]!.payload, { runId: "fl-d", seq: 1, ts: h.emitted[0]!.payload.ts, phase: "impl" });
    assert.deepEqual(
      { phase: h.emitted[1]!.payload.phase, summary: h.emitted[1]!.payload.summary, paths: h.emitted[1]!.payload.paths },
      { phase: "impl", summary: "did", paths: ["a.ts"] },
    );
    assert.deepEqual({ phase: h.emitted[2]!.payload.phase, error: h.emitted[2]!.payload.error }, { phase: "review", error: "nits" });
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("dispose() stops all publication", () => {
  const h = harness();
  h.bus.dispose();
  h.runLog.append("fl-e", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
  h.journal.append("fl-e", { type: "phase:started", phase: "p", ts: 1 });
  assert.equal(h.emitted.length, 0);
  rmSync(h.dir, { recursive: true, force: true });
});

test("a throwing emit() never breaks the append path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bus-boom-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const journal = new RunJournal(join(dir, "runs"));
    const bus = new FleetEventBus({ runLog, journal, emit: () => { throw new Error("bus boom"); } });
    runLog.append("fl-f", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
    assert.equal(runLog.replay("fl-f").length, 1, "event still persisted");
    bus.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#88: languageDrift fields forward on fleet:run:ended when set; absent when clean", () => {
  const h = harness();
  try {
    h.runLog.append("fl-d", { type: "run:meta", runId: "fl-d", agent: "scout", model: "m", task: "t", startedAt: 1000, track: true, todoId: null });
    h.runLog.append("fl-d", { type: "run:ended", runId: "fl-d", status: "completed", endedAt: 1500, tokenTotal: 3, languageDrift: true, languageDriftRatio: 0.62 });
    let last = h.emitted[h.emitted.length - 1]!;
    assert.equal(last.channel, "fleet:run:ended");
    assert.equal(last.payload.languageDrift, true, "drift flag forwards on the live bus");
    assert.equal(last.payload.languageDriftRatio, 0.62, "ratio forwards on the live bus");

    h.runLog.append("fl-d2", { type: "run:meta", runId: "fl-d2", agent: "scout", model: "m", task: "t", startedAt: 2000, track: true, todoId: null });
    h.runLog.append("fl-d2", { type: "run:ended", runId: "fl-d2", status: "completed", endedAt: 2500, tokenTotal: 3 });
    last = h.emitted[h.emitted.length - 1]!;
    assert.equal(last.channel, "fleet:run:ended");
    assert.equal("languageDrift" in last.payload, false, "clean run payload stays clean (no key)");
    assert.equal("languageDriftRatio" in last.payload, false, "clean run ratio stays absent (no key)");
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});
