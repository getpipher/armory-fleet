// src/panel/bg-runs-store.ts
// SPEC-5a proper-fix: a change-emitting store for live bg-run status rows.
//
// Replaces the bare `Map<string, BgRunStatus>` that `onProgress` used to mutate.
// The async runner's `onProgress` callback writes here on every phase transition
// and on completion; the /fleet panel subscribes so it re-renders the moment a
// bg run's status changes — even while the parent is idle (no `turn_end` fires
// for an async/fire-and-forget run). This is the SPEC-5b live-widget seam,
// delivered early as the proper fix for the stale "running" row bug.
import type { BgRunStatus } from "./rows.ts";

export type BgRunsChangeListener = (runId: string) => void;

export class BgRunsStore {
  private readonly runs = new Map<string, BgRunStatus>();
  private readonly listeners = new Set<BgRunsChangeListener>();

  set(runId: string, status: BgRunStatus): void {
    this.runs.set(runId, status);
    for (const fn of this.listeners) fn(runId);
  }

  get(runId: string): BgRunStatus | undefined {
    return this.runs.get(runId);
  }

  values(): IterableIterator<BgRunStatus> {
    return this.runs.values();
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  subscribe(fn: BgRunsChangeListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}