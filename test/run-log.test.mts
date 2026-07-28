// test/run-log.test.mts
import { test } from "node:test";
import assert, { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLog, excerpt, buildToolEvent } from "../src/runtime/run-log.ts";

function makeDir(): string { return mkdtempSync(join(tmpdir(), "runlog-test-")); }

test("excerpt truncates with ellipsis at the char limit; passes short strings through", () => {
  assert.equal(excerpt("short", 10), "short");
  assert.equal(excerpt("0123456789ABC", 10), "012345678…");
  assert.equal(excerpt("", 10), "");
  assert.equal(excerpt(undefined as unknown as string, 10), "", "non-string → empty");
});

test("append writes one JSON line per event; replay reconstructs in order", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  log.append("fl-1", { type: "message", role: "assistant", text: "hello", usage: { total: 42 }, turnIndex: 0 });
  log.append("fl-1", { type: "tool", toolName: "bash", args: "ls", result: "ok", isError: false, turnIndex: 0 });
  log.append("fl-1", { type: "run:ended", runId: "fl-1", status: "completed", endedAt: 2, resultSummary: "done", tokenTotal: 42 });
  const events = log.replay("fl-1");
  assert.equal(events.length, 4);
  assert.equal(events[0]!.type, "run:meta");
  assert.equal(events[3]!.type, "run:ended");
  rmSync(dir, { recursive: true, force: true });
});

test("replay discards a partial (no-newline) last line", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-2", { type: "run:meta", runId: "fl-2", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  const file = join(dir, "fl-2.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + '{"type":"message","role":"assistant","text":"partial"'); // no newline
  assert.equal(log.replay("fl-2").length, 1, "partial line discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("buildToolEvent keeps FULL result on isError; excerpts non-errors at 500; args at 200", () => {
  const big = "x".repeat(900);
  const err = buildToolEvent("bash", "pnpm test", big, true, 0);
  const ok = buildToolEvent("read", big, big, false, 1);
  assert.equal(err.result.length, 900, "error result kept in full");
  assert.equal(ok.result.length, 500, "non-error excerpted to 500");
  assert.equal(ok.args.length, 200, "args excerpted to 200");
  assert.equal(err.isError, true);
});

test("scanMeta rebuilds run list; status 'running' when no run:ended; completed when present", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-a", { type: "run:meta", runId: "fl-a", agent: "g", model: "m", task: "t1", startedAt: 10, track: true, todoId: null });
  log.append("fl-a", { type: "run:ended", runId: "fl-a", status: "completed", endedAt: 11, resultSummary: "s1", tokenTotal: 5 });
  log.append("fl-b", { type: "run:meta", runId: "fl-b", agent: "g", model: "m", task: "t2", startedAt: 20, track: true, todoId: null });
  const metas = log.scanMeta().sort((a, b) => a.startedAt - b.startedAt);
  assert.equal(metas.length, 2);
  assert.equal(metas[0]!.runId, "fl-a");
  assert.equal(metas[0]!.status, "completed");
  assert.equal(metas[0]!.resultSummary, "s1");
  assert.equal(metas[1]!.runId, "fl-b");
  assert.equal(metas[1]!.status, "running", "no run:ended → running");
  rmSync(dir, { recursive: true, force: true });
});

test("scanMeta: latest run:meta binding wins for backendSessionId/sessionKey; first startedAt", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-c", { type: "run:meta", runId: "fl-c", agent: "g", model: "m", task: "t", startedAt: 30, track: true, todoId: null });
  log.append("fl-c", { type: "run:meta", runId: "fl-c", agent: "g", model: "m", task: "t", startedAt: 30, track: true, todoId: null, backendSessionId: "sess-7", sessionKey: "g" });
  const metas = log.scanMeta();
  assert.equal(metas[0]!.backendSessionId, "sess-7", "latest binding wins");
  assert.equal(metas[0]!.sessionKey, "g");
  assert.equal(metas[0]!.startedAt, 30, "startedAt from first meta");
  rmSync(dir, { recursive: true, force: true });
});

test("scanMeta surfaces resumedFrom/forkedFrom from run:ended", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-d", { type: "run:meta", runId: "fl-d", agent: "g", model: "m", task: "t", startedAt: 40, track: true, todoId: null });
  log.append("fl-d", { type: "run:ended", runId: "fl-d", status: "completed", endedAt: 41, tokenTotal: 0, resumedFrom: "fl-prior" });
  assert.equal(log.scanMeta()[0]!.resumedFrom, "fl-prior");
  rmSync(dir, { recursive: true, force: true });
});

test("append never throws on I/O failure (best-effort); run proceeds", () => {
  // A path whose parent can't be created (root-level, non-root user) → mkdirSync throws fast on
  // both macOS + Linux. Avoid /proc (procfs) — writes there can block on Linux, hanging the test.
  const log = new RunLog("/nonexistent-fleet-test-root-xyz/no-write-here");
  assert.doesNotThrow(() => log.append("fl-x", { type: "run:meta", runId: "fl-x", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null }));
});
test("run:meta: pid + cwd round-trip through scanMeta", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-rl-"));
  const log = new RunLog(tmp);
  log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "a", model: "m", task: "t", startedAt: 1, track: true, todoId: null, pid: 999, cwd: "/repo" });
  const metas = log.scanMeta();
  strictEqual(metas[0]!.runId, "fl-1");
  strictEqual((metas[0] as any).pid, 999);
  strictEqual((metas[0] as any).cwd, "/repo");
  rmSync(tmp, { recursive: true, force: true });
});
