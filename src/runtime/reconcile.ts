// src/runtime/reconcile.ts
// SPEC-5b-1 — on pi boot, mark orphan RunLog runs (run:meta with no run:ended whose process
// is gone) as aborted so the Runs tab doesn't show stale "running" rows across restarts.
// Foreground orphans; bg/lifecycle orphans are already handled by scanResumeCandidates (SPEC-5a).
import type { RunLog } from "./run-log.ts";

export interface ReconcileOpts {
  /** Orphans whose startedAt is older than (now - graceMs) are marked aborted. Default 60000. */
  graceMs?: number;
  /** Test injection. Default Date.now(). */
  now?: number;
}

/** Returns the runIds it marked aborted. Idempotent: a run already ended is skipped. */
export function reconcileRuns(log: RunLog, opts: ReconcileOpts = {}): string[] {
  const grace = opts.graceMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const aborted: string[] = [];
  for (const meta of log.scanMeta()) {
    if (meta.status !== "running") continue;
    if (now - meta.startedAt <= grace) continue;
    log.append(meta.runId, {
      type: "run:ended", runId: meta.runId, status: "aborted",
      endedAt: now, resultSummary: "process-gone", tokenTotal: meta.tokenTotal,
    });
    aborted.push(meta.runId);
  }
  return aborted;
}