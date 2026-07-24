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