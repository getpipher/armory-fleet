// src/todo-sync/port.ts
/**
 * Fleet-owned todo-sync contract. Fleet core depends only on this port;
 * ArmoryTodoAdapter (src/todo-sync/adapter.ts) is the sole importer of
 * @getpipher/armory-todo. This insulation is what makes armory-todo
 * evolution safe — see SPEC-1 §6 / §2.2.
 */

export type FleetRunStatus = "running" | "completed" | "failed" | "aborted";

/** Minimum info the engine passes the port to link-or-create a run's todo. */
export interface RunMeta {
  runId: string;
  agent: string;
  task: string;
  /** explicit link to an existing open/in_progress todo; undefined = create. */
  todoId?: string;
  /** tracked-by-default (SPEC-1 Q3b); false = do not touch armory-todo. */
  track: boolean;
}

/**
 * Implementations return the linked/created todoId (or null when untracked)
 * and, for a linked todo, its prior status so the engine can restore it.
 * priorStatus is a string (armory-todo's Status union) to keep the port
 * decoupled from armory-todo's types.
 */
export interface LinkResult {
  todoId: string | null;
  /** undefined when the todo was freshly created (no prior status exists). */
  priorStatus?: string;
}

export interface TodoSyncPort {
  /** Before the run: link to todoId (validate open/in_progress) or create a fleet task. */
  linkOrCreateRunTodo(run: RunMeta): Promise<LinkResult>;
  /** After a completed run: fleet-created -> done; linked -> restore prior + result note. */
  markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void>;
  /** After a failed/aborted run: fleet-created -> open; linked -> restore prior. + reason note. */
  markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void>;
}