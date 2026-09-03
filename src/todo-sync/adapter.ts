// src/todo-sync/adapter.ts
import {
  addTodo,
  getTodo,
  listTodos,
  updateTodo,
  type Status,
} from "@getpipher/armory-todo";
import type { FleetTodoRow, LinkResult, RunMeta, TodoSyncPort } from "./port.ts";

const FLEET_PROJECT = "fleet";
const FLEET_SOURCE = "armory-fleet";
const FLEET_TAG = "fleet-run";
const OPEN_STATES: Status[] = ["open", "in_progress"];

/** #34: cap the task excerpt written into the TODO notes well below armory-todo's maxNotesBytes
 *  (8192). The full task already lives in the run-log + the fleet run record; the TODO is a
 *  tracking stub, not a transcript. 1024 leaves ~7KB headroom for the fleet-run header + the
 *  progress/done/reverted appends during the run. */
const TASK_EXCERPT_CAP = 1024;
/** Cap appended note lines (done-result / reverted-reason). The #25 turn-budget partial can be
 *  ~4000 chars; appending it verbatim would accumulate toward the cap on retries. */
const NOTE_LINE_CAP = 500;

function titleFor(run: RunMeta): string {
  const raw = `[${run.agent}] ${run.task}`.trim();
  return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
}

function taskExcerptFor(task: string): string {
  return task.length > TASK_EXCERPT_CAP
    ? task.slice(0, TASK_EXCERPT_CAP) + "…[truncated; full task in run-log]"
    : task;
}

function capNoteLine(s: string): string {
  return s.length > NOTE_LINE_CAP ? s.slice(0, NOTE_LINE_CAP) + "…" : s;
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
      notes: `fleet-run:${run.runId}\n\nTask: ${taskExcerptFor(run.task)}`,
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
    appendNote(todoId, `fleet-run done: ${capNoteLine(result)}`);
  }

  async markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void> {
    if (!todoId) return;
    if (priorStatus === undefined) {
      updateTodo(todoId, { status: "open" }); // created -> retryable
    } else {
      updateTodo(todoId, { status: priorStatus as Status });
    }
    appendNote(todoId, `fleet-run reverted: ${capNoteLine(reason)}`);
  }

  async updateLifecycleProgress(todoId: string, progressBlock: string): Promise<void> {
    if (!todoId) return;
    // single-writer: replace notes wholesale with the progress block (the lifecycle owns it)
    updateTodo(todoId, { notes: progressBlock });
  }

  /** #104: read-only projection for the orchestration TODO tree. Fleet never edits through this. */
  async listFleetTodos(): Promise<FleetTodoRow[]> {
    return listTodos({ tag: FLEET_TAG, limit: 100 }).map((t) => ({
      id: t.id,
      title: t.title,
      status: String(t.status),
      runId: /^fleet-run:(\S+)/m.exec(t.notes ?? "")?.[1] ?? null,
    }));
  }
}