import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import {
  createLifecycleTodo, updateProgress, completeLifecycleTodo, revertLifecycleTodo,
  buildProgressBlock, type FakeTodoPort,
} from "../src/lifecycle/lifecycle-todo.ts";

function makePort(): FakeTodoPort {
  const todos = new Map<string, { id: string; notes: string; status: string }>();
  let counter = 0;
  const port: FakeTodoPort = {
    async linkOrCreateRunTodo(run) {
      const id = `td-${++counter}`;
      todos.set(id, { id, notes: `run:${run.runId}`, status: "in_progress" });
      return { todoId: id };
    },
    async markRunTodoDone(todoId) { if (todoId && todos.has(todoId)) todos.get(todoId)!.status = "done"; },
    async markRunTodoReverted(todoId) { if (todoId && todos.has(todoId)) todos.get(todoId)!.status = "open"; },
    async updateLifecycleProgress(todoId, block) { const t = todos.get(todoId); if (t) t.notes = block; },
    _state: todos,
  };
  return port;
}

test("createLifecycleTodo creates one in_progress todo + returns its id", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "implement X", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm", "plan", "implement", "review", "finish"] });
  ok(id.startsWith("td-"));
  const t = port._state.get(id)!;
  strictEqual(t.status, "in_progress");
  ok(t.notes.includes("Lifecycle: default"));
  ok(t.notes.includes("[ ] brainstorm"));
});

test("updateProgress marks a phase done + updates Last line", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm", "plan"] });
  await updateProgress(port, id, { phase: "brainstorm", done: true, last: "brainstorm completed — design written", revising: false, attempt: 0 },
    { lifecycle: "default", task: "t", backend: "pi", mode: "checkpointed", phases: [{ name: "brainstorm", done: false }, { name: "plan", done: false }] });
  const t = port._state.get(id)!;
  ok(t.notes.includes("[x] brainstorm"));
  ok(t.notes.includes("[ ] plan"));
  ok(t.notes.includes("Last: brainstorm completed"));
});

test("updateProgress with revising shows [~] + attempt count", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["plan"] });
  await updateProgress(port, id, { phase: "plan", done: false, last: "", revising: true, attempt: 2 },
    { lifecycle: "default", task: "t", backend: "pi", mode: "checkpointed", phases: [{ name: "plan", done: false }] });
  ok(port._state.get(id)!.notes.includes("[~] plan (revising, attempt 2/3)"));
});

test("completeLifecycleTodo marks done; revertLifecycleTodo restores open", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm"] });
  await completeLifecycleTodo(port, id, "all phases done");
  strictEqual(port._state.get(id)!.status, "done");
  await revertLifecycleTodo(port, id, "aborted by user");
  strictEqual(port._state.get(id)!.status, "open");
});

test("buildProgressBlock renders the single-source-of-truth block", () => {
  const block = buildProgressBlock({
    lifecycle: "default", task: "implement X", backend: "pi", mode: "checkpointed",
    phases: [{ name: "brainstorm", done: true }, { name: "plan", done: false, revising: true, attempt: 1 }],
    last: "plan revising",
  });
  ok(block.includes("Lifecycle: default"));
  ok(block.includes("[x] brainstorm"));
  ok(block.includes("[~] plan (revising, attempt 1/3)"));
  ok(block.includes("Last: plan revising"));
});
test("updateProgress accumulates phase completion across calls (progress block is single source of truth)", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["a", "b", "c"] });
  const ctx = { lifecycle: "default", task: "t", backend: "pi" as const, mode: "checkpointed" as const, phases: [{ name: "a", done: false }, { name: "b", done: false }, { name: "c", done: false }] };
  await updateProgress(port, id, { phase: "a", done: true, last: "a done", revising: false, attempt: 0 }, ctx);
  await updateProgress(port, id, { phase: "b", done: true, last: "b done", revising: false, attempt: 0 }, ctx);
  const notes = port._state.get(id)!.notes;
  ok(notes.includes("[x] a"), "a stays [x] after b completes");
  ok(notes.includes("[x] b"), "b is [x]");
  ok(notes.includes("[ ] c"), "c still [ ]");
});
