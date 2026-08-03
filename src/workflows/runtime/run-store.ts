// SPEC-6-3 reactive run store — mirrors BgRunsStore pattern (private Map + listener Set)
// but values() returns newest-first by startedAt for panel ordering.

import type { WorkflowRunState } from "./types.ts";

export type WorkflowRunChangeListener = (runId: string) => void;

export class WorkflowRunStore {
  private readonly runs = new Map<string, WorkflowRunState>();
  private readonly listeners = new Set<WorkflowRunChangeListener>();

  set(runId: string, state: WorkflowRunState): void {
    this.runs.set(runId, state);
    for (const fn of this.listeners) fn(runId);
  }

  get(runId: string): WorkflowRunState | undefined {
    return this.runs.get(runId);
  }

  values(): WorkflowRunState[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  subscribe(listener: WorkflowRunChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
