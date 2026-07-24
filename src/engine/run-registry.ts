// src/engine/run-registry.ts
import type { FleetRunStatus } from "../todo-sync/port.ts";

export interface RunRecord {
  runId: string;
  agent: string;
  model: string;
  task: string;
  track: boolean;
  todoId: string | null;
  status: FleetRunStatus;
  startedAt: number;
  endedAt?: number;
  resultSummary?: string;
  /** Backend-native session id for resume (SPEC-3). */
  backendSessionId?: string | null;
  /** The sessionKey whose resume this run belongs to (SPEC-3). */
  sessionKey?: string | null;
}

/** runId format: fl-<base36 ms>-<6 random> (SPEC-1 §5.1). */
export function genRunId(): string {
  return "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  add(r: RunRecord): void {
    this.runs.set(r.runId, r);
  }
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  /** Newest-first (by startedAt desc). */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  update(id: string, patch: Partial<Omit<RunRecord, "runId">>): void {
    const r = this.runs.get(id);
    if (r) this.runs.set(id, { ...r, ...patch });
  }
}