// test/todo-list-fleet.test.mts — read-only listFleetTodos projection (#104).
// Store isolation: mirror of test/subagent-tool.test.mts (TODO_DIR → temp dir per test).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "todo-list-fleet-"));
  process.env.TODO_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

test("listFleetTodos returns fleet-run todos with parsed runIds", async () => {
  const adapter = new ArmoryTodoAdapter();
  const { todoId } = await adapter.linkOrCreateRunTodo({ runId: "fl-1", agent: "rev", task: "t", track: true });
  const rows = await adapter.listFleetTodos();
  const row = rows.find((r) => r.id === todoId);
  assert.ok(row);
  assert.equal(row.runId, "fl-1");
  assert.equal(row.status, "in_progress");
});

test("listFleetTodos is read-only — rows carry parsed ids and nothing mutates the store", async () => {
  const adapter = new ArmoryTodoAdapter();
  const a = await adapter.linkOrCreateRunTodo({ runId: "fl-a", agent: "x", task: "t", track: true });
  const b = await adapter.linkOrCreateRunTodo({ runId: "fl-b", agent: "y", task: "t", track: true });
  const first = await adapter.listFleetTodos();
  const second = await adapter.listFleetTodos();
  assert.deepEqual(first, second, "read-only: two calls see the same rows");
  assert.equal(first.length, 2, "both fleet-run todos projected");
  const ids = new Set(first.map((r) => r.id));
  assert.ok(ids.has(a.todoId!) && ids.has(b.todoId!), "both run todos present");
  const runIds = new Set(first.map((r) => r.runId));
  assert.ok(runIds.has("fl-a") && runIds.has("fl-b"), "runIds parsed from the notes marker");
});
