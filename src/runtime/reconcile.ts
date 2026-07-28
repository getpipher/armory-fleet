// src/runtime/reconcile.ts
// SPEC-5b-1 — on pi boot, mark orphan RunLog runs (run:meta with no run:ended whose process
// is gone) as aborted so the Runs tab doesn't show stale "running" rows across restarts.
// Foreground orphans; bg/lifecycle orphans are already handled by scanResumeCandidates (SPEC-5a).
//
// v0.10.2 patch: reconcile now ALSO syncs the in-memory RunRegistry (opts.runRegistry). Before this,
// reconcile only wrote run:ended: aborted to the durable RunLog — the in-memory RunRegistry kept
// status:"running", so the live above-editor widget (filterActive keeps running|queued|paused)
// rendered a stale ▶ row that ticked forever for every orphaned (process-gone) run.
import type { RunLog } from "./run-log.ts";
import type { RunRegistry } from "../engine/run-registry.ts";

export interface ReconcileOpts {
  /** Orphans whose startedAt is older than (now - graceMs) are marked aborted. Default 60000. */
  graceMs?: number;
  /** Test injection. Default Date.now(). */
  now?: number;
  /**
   * v0.10.2: the in-memory RunRegistry to sync alongside the durable log. When set, each orphan
   * reconciled in the log is also transitioned to status:"aborted" in memory so the live widget
   * clears its stale ▶ row. Optional — existing callers that pass only a RunLog are unaffected.
   */
  runRegistry?: RunRegistry;
}

/** Returns the runIds it marked aborted. Idempotent: a run already ended is skipped. */
export function reconcileRuns(log: RunLog, opts: ReconcileOpts = {}): string[] {
  const grace = opts.graceMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const reg = opts.runRegistry;
  const aborted: string[] = [];
  for (const meta of log.scanMeta()) {
    if (meta.status !== "running") continue;
    if (now - meta.startedAt <= grace) continue;
    log.append(meta.runId, {
      type: "run:ended", runId: meta.runId, status: "aborted",
      endedAt: now, resultSummary: "process-gone", tokenTotal: meta.tokenTotal,
    });
    // v0.10.2: sync the in-memory registry so the live widget (which reads runRegistry.list(),
    // not the RunLog) clears the orphan's stale ▶ row. No-op when the run isn't in the registry
    // (e.g. a cross-cwd orphan from another session — out of scope for this patch).
    reg?.update(meta.runId, { status: "aborted", endedAt: now });
    aborted.push(meta.runId);
  }
  return aborted;
}