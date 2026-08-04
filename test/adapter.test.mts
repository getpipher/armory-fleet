// test/adapter.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, rejects } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTodo, listTodos, getTodo, completeTodo } from "@getpipher/armory-todo";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-todo-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

test("untracked run touches no todo", async () => {
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-1", agent: "g", task: "x", track: false });
  strictEqual(res.todoId, null);
  strictEqual(listTodos({ limit: 200 }).length, 0);
});

test("tracked run with no todoId creates a fleet task in_progress", async () => {
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-2", agent: "scout", task: "do thing", track: true });
  ok(res.todoId, "todoId created");
  const t = getTodo(res.todoId!);
  strictEqual(t.project, "fleet");
  strictEqual(t.source, "armory-fleet");
  strictEqual(t.status, "in_progress");
  ok(t.tags.includes("fleet-run"));
  ok(t.notes.includes("fleet-run:fl-2"));
});

test("tracked run with todoId links + saves prior status + sets in_progress", async () => {
  const existing = addTodo({ title: "existing work", project: "myproj", source: "user" });
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-3", agent: "g", task: "x", track: true, todoId: existing.id });
  strictEqual(res.todoId, existing.id);
  strictEqual(res.priorStatus, "open");
  const t = getTodo(existing.id);
  strictEqual(t.status, "in_progress");
  ok(t.tags.includes("fleet-run"));
});

test("linking a done todo is rejected with an actionable message", async () => {
  const done = addTodo({ title: "done work", project: "p", source: "user" });
  completeTodo(done.id);
  const a = new ArmoryTodoAdapter();
  await rejects(
    () => a.linkOrCreateRunTodo({ runId: "fl-4", agent: "g", task: "x", track: true, todoId: done.id }),
    /cannot start run against a closed todo/,
  );
});

test("markRunTodoDone: created -> done; linked -> restore prior + note", async () => {
  const a = new ArmoryTodoAdapter();
  const created = await a.linkOrCreateRunTodo({ runId: "fl-5", agent: "g", task: "x", track: true });
  await a.markRunTodoDone(created.todoId, created.priorStatus, "result text");
  strictEqual(getTodo(created.todoId!).status, "done");
  ok(getTodo(created.todoId!).notes.includes("result text"));

  const existing = addTodo({ title: "link work", project: "p", source: "user" });
  const linked = await a.linkOrCreateRunTodo({ runId: "fl-6", agent: "g", task: "x", track: true, todoId: existing.id });
  await a.markRunTodoDone(linked.todoId, linked.priorStatus, "linked result");
  strictEqual(getTodo(existing.id).status, "open"); // restored prior
  ok(getTodo(existing.id).notes.includes("linked result"));
});

test("markRunTodoReverted: created -> open; linked -> restore prior + reason", async () => {
  const a = new ArmoryTodoAdapter();
  const created = await a.linkOrCreateRunTodo({ runId: "fl-7", agent: "g", task: "x", track: true });
  await a.markRunTodoReverted(created.todoId, created.priorStatus, "aborted by user");
  strictEqual(getTodo(created.todoId!).status, "open");
  ok(getTodo(created.todoId!).notes.includes("aborted by user"));

  const existing = addTodo({ title: "link2", project: "p", source: "user" });
  const linked = await a.linkOrCreateRunTodo({ runId: "fl-8", agent: "g", task: "x", track: true, todoId: existing.id });
  await a.markRunTodoReverted(linked.todoId, linked.priorStatus, "failed: budget");
  strictEqual(getTodo(existing.id).status, "open"); // restored prior (was open)
  ok(getTodo(existing.id).notes.includes("failed: budget"));
});

test("#34: track:true with a >8KB task creates the todo (task excerpt capped, not rejected)", async () => {
  // The bug: the full task was dumped into `notes`, breaching armory-todo's maxNotesBytes (8192)
  // → addTodo hard-rejected → the dispatch never ran. The full task already lives in the run-log;
  // the TODO is a tracking stub. Fix: cap the task excerpt to 1024 with a truncation marker.
  const hugeTask = "Detailed 5-part steering contract:\n" + "x".repeat(10_000);
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-9", agent: "auditor", task: hugeTask, track: true });
  ok(res.todoId, "todo created (not rejected by the cap)");
  const t = getTodo(res.todoId!);
  strictEqual(t.status, "in_progress");
  ok(t.notes.includes("fleet-run:fl-9"), "notes carry the fleet-run header");
  ok(t.notes.includes("[truncated; full task in run-log]"), "excerpt is capped with a marker");
  ok(t.notes.length < 8192, `notes must stay under maxNotesBytes: ${t.notes.length}`);
  // The title is independently capped (titleFor → 120).
  ok(t.title.length <= 120, `title capped: ${t.title.length}`);
});

test("#34: track:true with a short task keeps the whole task in notes (no truncation marker)", async () => {
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-10", agent: "g", task: "do a small thing", track: true });
  const t = getTodo(res.todoId!);
  ok(t.notes.includes("do a small thing"), "short task kept whole");
  ok(!t.notes.includes("[truncated"), "no truncation marker for short task");
});

test("#34: markRunTodoReverted with a long reason (~4000-char budget partial) does not breach the cap", async () => {
  // The #25 turn-budget partial can be ~4000 chars; appending it verbatim would accumulate
  // toward maxNotesBytes on retries. The adapter caps appended note lines at 500.
  const a = new ArmoryTodoAdapter();
  const created = await a.linkOrCreateRunTodo({ runId: "fl-11", agent: "g", task: "x", track: true });
  const longReason = "hit turn budget (12) mid-task; partial result:\n" + "y".repeat(4_000);
  await a.markRunTodoReverted(created.todoId, created.priorStatus, longReason);
  const t = getTodo(created.todoId!);
  ok(t.notes.length < 8192, `notes must stay under maxNotesBytes after a long reason: ${t.notes.length}`);
  ok(t.notes.includes("hit turn budget"), "reason prefix preserved");
  ok(t.notes.endsWith("…"), "long reason is capped with an ellipsis");
});