// test/reconcile.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLog } from "../src/runtime/run-log.ts";
import { reconcileRuns } from "../src/runtime/reconcile.ts";

function makeDir(): string { return mkdtempSync(join(tmpdir(), "reconcile-")); }
const GRACE = 60_000;

test("orphan run:meta with no run:ended, older than grace → marked aborted", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const oldStarted = 1_000; // long ago
  log.append("fl-old", { type: "run:meta", runId: "fl-old", agent: "g", model: "m", task: "t", startedAt: oldStarted, track: true, todoId: null });
  const aborted = reconcileRuns(log, { now: oldStarted + GRACE + 5_000 });
  assert.deepEqual(aborted, ["fl-old"]);
  const meta = log.scanMeta()[0]!;
  assert.equal(meta.status, "aborted");
  assert.equal(meta.resultSummary, "process-gone");
  rmSync(dir, { recursive: true, force: true });
});

test("fresh orphan (within grace) left as running", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const now = 50_000;
  log.append("fl-fresh", { type: "run:meta", runId: "fl-fresh", agent: "g", model: "m", task: "t", startedAt: now - 1_000, track: true, todoId: null });
  assert.deepEqual(reconcileRuns(log, { now }), []);
  assert.equal(log.scanMeta()[0]!.status, "running");
  rmSync(dir, { recursive: true, force: true });
});

test("completed run (has run:ended) is untouched", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-done", { type: "run:meta", runId: "fl-done", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  log.append("fl-done", { type: "run:ended", runId: "fl-done", status: "completed", endedAt: 2, tokenTotal: 0 });
  assert.deepEqual(reconcileRuns(log, { now: 999_999_999 }), []);
  assert.equal(log.scanMeta()[0]!.status, "completed");
  rmSync(dir, { recursive: true, force: true });
});

test("default now = Date.now(); graceMs default 60000", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  // startedAt 1 (1970) → always older than grace
  log.append("fl-ancient", { type: "run:meta", runId: "fl-ancient", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  assert.deepEqual(reconcileRuns(log), ["fl-ancient"]);
  rmSync(dir, { recursive: true, force: true });
});
// SPEC-6-1 patch (v0.10.2): reconcile must also sync the in-memory RunRegistry, not just the
// durable RunLog. Otherwise orphaned (process-gone) runs stay status:"running" in memory and the
// live widget (filterActive keeps running|queued|paused) shows a stale ▶ row forever.
import { RunRegistry } from "../src/engine/run-registry.ts";

test("reconcile also marks the orphan aborted in the in-memory RunRegistry (v0.10.2)", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const reg = new RunRegistry();
  const oldStarted = 1_000;
  // The orphan exists in BOTH stores: durable log (run:meta, no run:ended) + in-memory registry (running).
  log.append("fl-ghost", { type: "run:meta", runId: "fl-ghost", agent: "g", model: "m", task: "t", startedAt: oldStarted, track: true, todoId: null });
  reg.add({ runId: "fl-ghost", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: oldStarted , cwd: "/", backend: "pi"});
  const aborted = reconcileRuns(log, { runRegistry: reg, now: oldStarted + GRACE + 5_000 });
  assert.deepEqual(aborted, ["fl-ghost"]);
  // Durable log updated (existing behavior).
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  // NEW: in-memory registry also updated — the ghost row must clear from the live widget.
  assert.equal(reg.get("fl-ghost")!.status, "aborted", "in-memory RunRegistry must transition to aborted so the widget stops showing ▶");
  rmSync(dir, { recursive: true, force: true });
});

test("reconcile leaves a fresh orphan running in-memory (within grace)", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const reg = new RunRegistry();
  const now = 50_000;
  log.append("fl-fresh", { type: "run:meta", runId: "fl-fresh", agent: "g", model: "m", task: "t", startedAt: now - 1_000, track: true, todoId: null });
  reg.add({ runId: "fl-fresh", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: now - 1_000 , cwd: "/", backend: "pi"});
  assert.deepEqual(reconcileRuns(log, { runRegistry: reg, now }), []);
  assert.equal(reg.get("fl-fresh")!.status, "running", "fresh run untouched in-memory");
  rmSync(dir, { recursive: true, force: true });
});

test("reconcile RunRegistry arg is optional (back-compat: existing callers passing only log)", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-solo", { type: "run:meta", runId: "fl-solo", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  // No RunRegistry passed — must not throw.
  assert.deepEqual(reconcileRuns(log, { now: 999_999_999 }), ["fl-solo"]);
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  rmSync(dir, { recursive: true, force: true });
});
