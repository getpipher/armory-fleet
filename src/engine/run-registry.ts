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
  /** SPEC-5b-1: runId this run resumed from (rehydrated the prior sessionKey + a follow-up). */
  resumedFrom?: string;
  /** SPEC-5b-1: runId this run forked from (fresh re-run with same agent+task). */
  forkedFrom?: string;
  /** SPEC-5b-2: cumulative real tokens (input+output+cacheRead+cacheWrite) — live, updated on each message_end. */
  tokenTotal?: number;
}

/** runId format: fl-<base36 ms>-<6 random> (SPEC-1 §5.1). */
export function genRunId(): string {
  return "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export type RunRegistryChangeListener = () => void;

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<RunRegistryChangeListener>();

  add(r: RunRecord): void {
    this.runs.set(r.runId, r);
    this.emit();
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
    if (r) { this.runs.set(id, { ...r, ...patch }); this.emit(); }
  }
  /** SPEC-5a proper-fix: subscribe to add/update mutations. Returns an unsubscribe fn. */
  subscribe(fn: RunRegistryChangeListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}