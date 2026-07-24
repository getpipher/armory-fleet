// src/todo-sync/adapter.ts
import {
  addTodo,
  getTodo,
  updateTodo,
  type Status,
} from "@getpipher/armory-todo";
import type { LinkResult, RunMeta, TodoSyncPort } from "./port.ts";

const FLEET_PROJECT = "fleet";
const FLEET_SOURCE = "armory-fleet";
const FLEET_TAG = "fleet-run";
const OPEN_STATES: Status[] = ["open", "in_progress"];

function titleFor(run: RunMeta): string {
  const raw = `[${run.agent}] ${run.task}`.trim();
  return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
}

/** Append a note line to a todo (read-then-write; updateTodo replaces notes). */
function appendNote(id: string, line: string): void {
  const t = getTodo(id);
  const sep = t.notes ? "\n\n" : "";
  updateTodo(id, { notes: t.notes + sep + line });
}

/** Add the fleet-run tag if missing (read-then-write; updateTodo replaces tags). */
function ensureFleetTag(id: string): void {
  const t = getTodo(id);
  if (!t.tags.includes(FLEET_TAG)) updateTodo(id, { tags: [...t.tags, FLEET_TAG] });
}

export class ArmoryTodoAdapter implements TodoSyncPort {
  async linkOrCreateRunTodo(run: RunMeta): Promise<LinkResult> {
    if (!run.track) return { todoId: null };

    if (run.todoId) {
      const t = getTodo(run.todoId);
      if (!OPEN_STATES.includes(t.status)) {
        throw new Error(
          `linked todo ${run.todoId} is ${t.status}; cannot start run against a closed todo`,
        );
      }
      const priorStatus = t.status;
      ensureFleetTag(run.todoId);
      appendNote(run.todoId, `fleet-run:${run.runId}`);
      updateTodo(run.todoId, { status: "in_progress" });
      return { todoId: run.todoId, priorStatus: String(priorStatus) };
    }

    const created = addTodo({
      title: titleFor(run),
      project: FLEET_PROJECT,
      source: FLEET_SOURCE,
      priority: "med",
      tags: [FLEET_TAG],
      notes: `fleet-run:${run.runId}\n\nTask: ${run.task}`,
    });
    updateTodo(created.id, { status: "in_progress" });
    return { todoId: created.id }; // priorStatus undefined -> created
  }

  async markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void> {
    if (!todoId) return;
    if (priorStatus === undefined) {
      // fleet-created -> fleet closes it
      updateTodo(todoId, { status: "done" });
    } else {
      // linked -> restore prior (user owns the close)
      updateTodo(todoId, { status: priorStatus as Status });
    }
    appendNote(todoId, `fleet-run done: ${result}`);
  }

  async markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void> {
    if (!todoId) return;
    if (priorStatus === undefined) {
      updateTodo(todoId, { status: "open" }); // created -> retryable
    } else {
      updateTodo(todoId, { status: priorStatus as Status });
    }
    appendNote(todoId, `fleet-run reverted: ${reason}`);
  }
}