// src/runtime/reconcile.ts
// SPEC-6-3 — restart-recovery: scan workflow journals for non-terminal runs
// (interrupted workflows become resume candidates in the Workflows view).
import { WorkflowJournal } from "../workflows/journal.ts";
import type { RunLog } from "./run-log.ts";
import type { RunRegistry, RunRecord } from "../engine/run-registry.ts";

export type Liveness = "alive" | "dead";

/** SPEC-6-2: real probe first (handle / pid), age+grace fallback for cross-process pi-backend orphans. */
export function probeRun(rec: { status: string; session?: { isAlive?: () => boolean }; pid?: number; startedAt: number }, now: number, grace: number): Liveness {
  // 1. in-process handle
  if (rec.session && typeof rec.session.isAlive === "function") {
    return rec.session.isAlive() ? "alive" : "dead";
  }
  // 2. pid (works cross-process — system-wide)
  if (typeof rec.pid === "number") {
    try { process.kill(rec.pid, 0); return "alive"; } catch { return "dead"; }
  }
  // 3. fallback — cross-process pi-backend orphan, no reachable probe
  return (now - rec.startedAt > grace) ? "dead" : "alive";
}

export interface ReconcileOpts {
  graceMs?: number;
  now?: number;
  runRegistry?: RunRegistry;
}

/** Returns the runIds it marked aborted. Probe-driven (SPEC-6-2); idempotent. */
export function reconcileRuns(log: RunLog, opts: ReconcileOpts = {}): string[] {
  const grace = opts.graceMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const reg = opts.runRegistry;
  const aborted: string[] = [];
  for (const meta of log.scanMeta()) {
    if (meta.status !== "running") continue;
    // The in-memory record (if present) carries the live handle/pid; the log meta carries pid for cross-process.
    const memRec = reg?.get(meta.runId);
    const probeRec = memRec ?? { status: meta.status, pid: (meta as { pid?: number }).pid, startedAt: meta.startedAt };
    if (probeRun(probeRec, now, grace) !== "dead") continue;
    log.append(meta.runId, {
      type: "run:ended", runId: meta.runId, status: "aborted",
      endedAt: now, resultSummary: "process-gone (probe)", tokenTotal: meta.tokenTotal,
    });
    reg?.update(meta.runId, { status: "aborted", endedAt: now });
    aborted.push(meta.runId);
  }
  return aborted;
}

/** SPEC-6-3 — on pi start, scan .pi/fleet/workflows/ for non-terminal workflow journals.
 *  Returns runIds whose journal has no wf:completed/wf:aborted event — these are
 *  interrupted workflows that the Workflows view surfaces as resume candidates. */
export function scanWorkflowResumeCandidates(workflowsDir: string): string[] {
  const journal = new WorkflowJournal(workflowsDir);
  return journal.scanNonTerminal();
}

