// src/lifecycle/lifecycle-todo.ts
import type { BackendId, LifecycleMode } from "./lifecycle-types.ts";

/** Minimal port shape the lifecycle-todo helpers need (so unit tests can pass a fake
 *  without depending on the full TodoSyncPort). */
export interface LifecycleTodoPort {
  linkOrCreateRunTodo(run: { runId: string; agent: string; task: string; todoId?: string; track: boolean }): Promise<{ todoId: string | null; priorStatus?: string }>;
  markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void>;
  markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void>;
  updateLifecycleProgress(todoId: string, progressBlock: string): Promise<void>;
}

/** Test fake helper type (re-exported so tests don't hand-roll the shape). */
export interface FakeTodoPort extends LifecycleTodoPort {
  _state: Map<string, { id: string; notes: string; status: string }>;
}

export interface LifecycleTodoMeta {
  runId: string; task: string; lifecycle: string; backend: BackendId; mode: LifecycleMode;
  phases: string[];
}

export interface ProgressPhase {
  name: string;
  done: boolean;
  revising?: boolean;
  attempt?: number;
}

export function buildProgressBlock(opts: {
  lifecycle: string; task: string; backend: BackendId; mode: LifecycleMode;
  phases: ProgressPhase[]; last: string;
}): string {
  const marks = opts.phases.map((p) => {
    if (p.done) return `[x] ${p.name}`;
    if (p.revising) return `[~] ${p.name} (revising, attempt ${p.attempt ?? 1}/3)`;
    return `[ ] ${p.name}`;
  }).join("  ");
  return [
    `Lifecycle: ${opts.lifecycle} · task: "${opts.task}"`,
    `Backend: ${opts.backend} · Mode: ${opts.mode}`,
    `Phases: ${marks}`,
    `Last: ${opts.last}`,
  ].join("\n");
}

export async function createLifecycleTodo(port: LifecycleTodoPort, meta: LifecycleTodoMeta): Promise<string> {
  const link = await port.linkOrCreateRunTodo({
    runId: meta.runId, agent: meta.lifecycle, task: meta.task, track: true,
  });
  if (!link.todoId) throw new Error("lifecycle TODO link-or-create returned null (armory-todo port error)");
  await port.updateLifecycleProgress(link.todoId, buildProgressBlock({
    lifecycle: meta.lifecycle, task: meta.task, backend: meta.backend, mode: meta.mode,
    phases: meta.phases.map((n) => ({ name: n, done: false })), last: "started",
  }));
  return link.todoId;
}

export async function updateProgress(
  port: LifecycleTodoPort, todoId: string,
  upd: { phase: string; done: boolean; last: string; revising: boolean; attempt: number },
  ctx: { lifecycle: string; task: string; backend: BackendId; mode: LifecycleMode; phases: ProgressPhase[] },
): Promise<void> {
  const phases = ctx.phases.map((p) =>
    p.name === upd.phase ? { name: p.name, done: upd.done, revising: upd.revising, attempt: upd.attempt } : p,
  );
  await port.updateLifecycleProgress(todoId, buildProgressBlock({
    lifecycle: ctx.lifecycle, task: ctx.task, backend: ctx.backend, mode: ctx.mode, phases, last: upd.last,
  }));
}

export async function completeLifecycleTodo(port: LifecycleTodoPort, todoId: string, result: string): Promise<void> {
  await port.markRunTodoDone(todoId, undefined, result);
}

export async function revertLifecycleTodo(port: LifecycleTodoPort, todoId: string, reason: string): Promise<void> {
  await port.markRunTodoReverted(todoId, undefined, reason);
}