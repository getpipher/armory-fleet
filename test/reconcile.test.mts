// test/reconcile.test.mts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLog } from "../src/runtime/run-log.ts";
import { reconcileRuns, probeRun } from "../src/runtime/reconcile.ts";
import type { TodoSyncPort } from "../src/todo-sync/port.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { addTodo, getTodo } from "@getpipher/armory-todo";

function makeDir(): string { return mkdtempSync(join(tmpdir(), "reconcile-")); }
const GRACE = 60_000;

test("orphan run:meta with no run:ended, older than grace → marked aborted", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const oldStarted = 1_000; // long ago
  log.append("fl-old", { type: "run:meta", runId: "fl-old", agent: "g", model: "m", task: "t", startedAt: oldStarted, track: true, todoId: null });
  const aborted = await reconcileRuns(log, { now: oldStarted + GRACE + 5_000 });
  assert.deepEqual(aborted, ["fl-old"]);
  const meta = log.scanMeta()[0]!;
  assert.equal(meta.status, "aborted");
  assert.equal(meta.resultSummary, "process-gone (probe)");
  rmSync(dir, { recursive: true, force: true });
});

test("fresh orphan (within grace) left as running", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const now = 50_000;
  log.append("fl-fresh", { type: "run:meta", runId: "fl-fresh", agent: "g", model: "m", task: "t", startedAt: now - 1_000, track: true, todoId: null });
  assert.deepEqual(await reconcileRuns(log, { now }), []);
  assert.equal(log.scanMeta()[0]!.status, "running");
  rmSync(dir, { recursive: true, force: true });
});

test("completed run (has run:ended) is untouched", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-done", { type: "run:meta", runId: "fl-done", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  log.append("fl-done", { type: "run:ended", runId: "fl-done", status: "completed", endedAt: 2, tokenTotal: 0 });
  assert.deepEqual(await reconcileRuns(log, { now: 999_999_999 }), []);
  assert.equal(log.scanMeta()[0]!.status, "completed");
  rmSync(dir, { recursive: true, force: true });
});

test("default now = Date.now(); graceMs default 60000", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  // startedAt 1 (1970) → always older than grace
  log.append("fl-ancient", { type: "run:meta", runId: "fl-ancient", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  assert.deepEqual(await reconcileRuns(log), ["fl-ancient"]);
  rmSync(dir, { recursive: true, force: true });
});
// SPEC-6-1 patch (v0.10.2): reconcile must also sync the in-memory RunRegistry, not just the
// durable RunLog. Otherwise orphaned (process-gone) runs stay status:"running" in memory and the
// live widget (filterActive keeps running|queued|paused) shows a stale ▶ row forever.
import { RunRegistry } from "../src/engine/run-registry.ts";

test("reconcile also marks the orphan aborted in the in-memory RunRegistry (v0.10.2)", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const reg = new RunRegistry();
  const oldStarted = 1_000;
  // The orphan exists in BOTH stores: durable log (run:meta, no run:ended) + in-memory registry (running).
  log.append("fl-ghost", { type: "run:meta", runId: "fl-ghost", agent: "g", model: "m", task: "t", startedAt: oldStarted, track: true, todoId: null });
  reg.add({ runId: "fl-ghost", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: oldStarted , cwd: "/", backend: "pi"});
  const aborted = await reconcileRuns(log, { runRegistry: reg, now: oldStarted + GRACE + 5_000 });
  assert.deepEqual(aborted, ["fl-ghost"]);
  // Durable log updated (existing behavior).
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  // NEW: in-memory registry also updated — the ghost row must clear from the live widget.
  assert.equal(reg.get("fl-ghost")!.status, "aborted", "in-memory RunRegistry must transition to aborted so the widget stops showing ▶");
  rmSync(dir, { recursive: true, force: true });
});

test("reconcile leaves a fresh orphan running in-memory (within grace)", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const reg = new RunRegistry();
  const now = 50_000;
  log.append("fl-fresh", { type: "run:meta", runId: "fl-fresh", agent: "g", model: "m", task: "t", startedAt: now - 1_000, track: true, todoId: null });
  reg.add({ runId: "fl-fresh", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: now - 1_000 , cwd: "/", backend: "pi"});
  assert.deepEqual(await reconcileRuns(log, { runRegistry: reg, now }), []);
  assert.equal(reg.get("fl-fresh")!.status, "running", "fresh run untouched in-memory");
  rmSync(dir, { recursive: true, force: true });
});

test("reconcile RunRegistry arg is optional (back-compat: existing callers passing only log)", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-solo", { type: "run:meta", runId: "fl-solo", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  // No RunRegistry passed — must not throw.
  assert.deepEqual(await reconcileRuns(log, { now: 999_999_999 }), ["fl-solo"]);
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  rmSync(dir, { recursive: true, force: true });
});

// SPEC-6-2: probeRun + probe-driven reconcile tests
const deadHandle = { isAlive: () => false } as any;
const aliveHandle = { isAlive: () => true } as any;

test("probeRun: in-process handle isAlive:false → dead", () => {
  assert.strictEqual(probeRun({ status: "running", session: deadHandle } as any, 1000, 60_000), "dead");
});

test("probeRun: in-process handle isAlive:true → alive", () => {
  assert.strictEqual(probeRun({ status: "running", session: aliveHandle, startedAt: 900 } as any, 1000, 60_000), "alive");
});

test("probeRun: pid dead → dead", () => {
  // pid that definitely doesn't exist (use a huge number; signal 0 throws ESRCH)
  assert.strictEqual(probeRun({ status: "running", pid: 4_000_000, startedAt: 0 } as any, 1000, 60_000), "dead");
});

test("probeRun: no handle, no pid, age > grace → dead (fallback)", () => {
  assert.strictEqual(probeRun({ status: "running", startedAt: 0 } as any, 100_000, 60_000), "dead");
});

test("probeRun: no handle, no pid, age < grace → alive (fallback)", () => {
  assert.strictEqual(probeRun({ status: "running", startedAt: 99_999 } as any, 100_000, 60_000), "alive");
});

test("reconcileRuns: probe-driven — handle-dead orphan aborted in log + registry", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-rec-"));
  const log = new RunLog(tmp);
  log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "a", model: "m", task: "t", startedAt: 0, track: true, todoId: null, cwd: "/repo" });
  const reg = new RunRegistry();
  reg.add({ runId: "fl-1", agent: "a", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 0, cwd: "/repo", backend: "pi", session: deadHandle });
  const aborted = await reconcileRuns(log, { now: 100_000, graceMs: 60_000, runRegistry: reg });
  assert.deepEqual(aborted, ["fl-1"]);
  assert.strictEqual(reg.get("fl-1")!.status, "aborted");
  rmSync(tmp, { recursive: true, force: true });
});

test("reconcileRuns: alive handle → not aborted", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-rec2-"));
  const log = new RunLog(tmp);
  log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "a", model: "m", task: "t", startedAt: 0, track: true, todoId: null, cwd: "/repo" });
  const reg = new RunRegistry();
  reg.add({ runId: "fl-1", agent: "a", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 0, cwd: "/repo", backend: "pi", session: aliveHandle });
  const aborted = await reconcileRuns(log, { now: 100_000, graceMs: 60_000, runRegistry: reg });
  assert.deepEqual(aborted, []);
  assert.strictEqual(reg.get("fl-1")!.status, "running");
  rmSync(tmp, { recursive: true, force: true });
});

// ── #22 bg-watchdog: a process-gone run's linked TODO is reverted to open (retryable) ──

let todoTmpDir: string;
before(() => { todoTmpDir = mkdtempSync(join(tmpdir(), "fleet-rec-todo-")); process.env.TODO_DIR = todoTmpDir; });
after(() => { rmSync(todoTmpDir, { recursive: true, force: true }); delete process.env.TODO_DIR; });

/** A recording TodoSyncPort that delegates to ArmoryTodoAdapter so a real fleet TODO is created/transitioned. */
function recordingTodoSync(): { port: TodoSyncPort; calls: string[] } {
  const calls: string[] = [];
  const real = new ArmoryTodoAdapter() as TodoSyncPort;
  const wrap = (name: string, fn: (...a: never[]) => Promise<unknown>) => async (...a: never[]) => {
    calls.push(`${name}:${JSON.stringify(a[0])}`);
    return fn(...a);
  };
  return {
    port: {
      linkOrCreateRunTodo: wrap("linkOrCreate", real.linkOrCreateRunTodo.bind(real) as never) as TodoSyncPort["linkOrCreateRunTodo"],
      markRunTodoDone: wrap("markDone", real.markRunTodoDone.bind(real) as never) as TodoSyncPort["markRunTodoDone"],
      markRunTodoReverted: wrap("markReverted", real.markRunTodoReverted.bind(real) as never) as TodoSyncPort["markRunTodoReverted"],
      updateLifecycleProgress: real.updateLifecycleProgress.bind(real),
      listFleetTodos: real.listFleetTodos.bind(real),
    },
    calls,
  };
}

test("#22: process-gone run with a linked TODO → TODO reverted to open + WORKER_EXITED note", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  const todoId = addTodo({ title: "[auditor] review the spec", project: "fleet", source: "armory-fleet", priority: "med", tags: ["fleet-run"], notes: "fleet-run:fl-22\n\nTask: review" }).id;
  // mark it in_progress (as linkOrCreateRunTodo would)
  // orphan: run:meta with a todoId, no run:ended, older than grace
  log.append("fl-22", { type: "run:meta", runId: "fl-22", agent: "auditor", model: "m", task: "review", startedAt: 1_000, track: true, todoId });
  const { port, calls } = recordingTodoSync();
  const aborted = await reconcileRuns(log, { now: 1_000 + GRACE + 5_000, todoSync: port });
  assert.deepEqual(aborted, ["fl-22"]);
  // The TODO was reverted (markRunTodoReverted called with priorStatus undefined → open)
  assert.ok(calls.some((c) => c.startsWith("markReverted:")), `todoSync.markRunTodoReverted should be called: ${calls}`);
  const t = getTodo(todoId);
  assert.equal(t.status, "open", "TODO reverted to open (retryable), not stuck in_progress");
  assert.ok(t.notes.includes("WORKER_EXITED_WITHOUT_RESULT"), `note should carry the diagnostic: ${t.notes}`);
  assert.ok(t.notes.includes("process gone (probe)"), `note should carry the probe reason: ${t.notes}`);
  rmSync(dir, { recursive: true, force: true });
});

test("#22: process-gone run with no todoId (track:false) → no todoSync call", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-notrack", { type: "run:meta", runId: "fl-notrack", agent: "g", model: "m", task: "t", startedAt: 1, track: false, todoId: null });
  const { port, calls } = recordingTodoSync();
  const aborted = await reconcileRuns(log, { now: 999_999_999, todoSync: port });
  assert.deepEqual(aborted, ["fl-notrack"]);
  assert.equal(calls.length, 0, "no todoSync call when the run has no todoId (track:false)");
  rmSync(dir, { recursive: true, force: true });
});

test("#22: todoSync arg is optional (back-compat: callers not wiring it)", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-nots", { type: "run:meta", runId: "fl-nots", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: "td-x" });
  // No todoSync passed — must not throw; run still marked aborted in log/registry.
  const aborted = await reconcileRuns(log, { now: 999_999_999 });
  assert.deepEqual(aborted, ["fl-nots"]);
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  rmSync(dir, { recursive: true, force: true });
});

test("#22: a failing todoSync (e.g. deleted TODO) is best-effort — run still marked aborted", async () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-failtodo", { type: "run:meta", runId: "fl-failtodo", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: "td-gone" });
  const failingPort: TodoSyncPort = {
    linkOrCreateRunTodo: async () => ({ todoId: null }),
    markRunTodoDone: async () => {},
    markRunTodoReverted: async () => { throw new Error("todo not found"); },
    updateLifecycleProgress: async () => {},
    listFleetTodos: async () => [],
  };
  // Must not throw — the failure is swallowed (best-effort); the run is still aborted in the log.
  const aborted = await reconcileRuns(log, { now: 999_999_999, todoSync: failingPort });
  assert.deepEqual(aborted, ["fl-failtodo"]);
  assert.equal(log.scanMeta()[0]!.status, "aborted");
  rmSync(dir, { recursive: true, force: true });
});

// SPEC-6-3 Task 10 — restart-recovery: scan workflow journals for non-terminal runs.
import { scanWorkflowResumeCandidates } from "../src/runtime/reconcile.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";

test("scanWorkflowResumeCandidates: non-terminal workflow → resume candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-rec-"));
  try {
    const j = new WorkflowJournal(dir);
    j.append("wf-x", { type: "wf:started", runId: "wf-x", script: "x", mode: "auto", ts: 1 });
    j.append("wf-x", { type: "agent:call", callIndex: 0, label: "a0", phase: "p", prompt: "x", opts: {}, ts: 2 });
    // wf-x has no terminal event
    const cands = scanWorkflowResumeCandidates(dir);
    assert.deepEqual(cands, ["wf-x"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanWorkflowResumeCandidates: terminal workflow → skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-rec2-"));
  try {
    const j = new WorkflowJournal(dir);
    j.append("wf-y", { type: "wf:started", runId: "wf-y", script: "y", mode: "auto", ts: 1 });
    j.append("wf-y", { type: "wf:completed", runId: "wf-y", result: null, ts: 2 });
    assert.deepEqual(scanWorkflowResumeCandidates(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanWorkflowResumeCandidates: missing dir → []", () => {
  assert.deepEqual(scanWorkflowResumeCandidates(join(tmpdir(), "no-wf-" + Date.now())), []);
});
