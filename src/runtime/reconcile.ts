// src/runtime/reconcile.ts
// SPEC-6-3 — restart-recovery: scan workflow journals for non-terminal runs
// (interrupted workflows become resume candidates in the Workflows view).
import { WorkflowJournal } from "../workflows/journal.ts";
import type { RunLog } from "./run-log.ts";
import type { RunRegistry, RunRecord } from "../engine/run-registry.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";

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
  /** #22 bg-watchdog: when wired, a process-gone run's linked TODO is reverted to open
   *  (retryable) with a WORKER_EXITED_WITHOUT_RESULT note, so it doesn't stay in_progress
   *  forever after a worker exits without a terminal record. Best-effort (the run is already
   *  marked aborted in the log + registry). */
  todoSync?: TodoSyncPort;
}

/** Returns the runIds it marked aborted. Probe-driven (SPEC-6-2); idempotent.
 *  #22: async — awaits the best-effort TODO transition for each aborted run with a todoId. */
export async function reconcileRuns(log: RunLog, opts: ReconcileOpts = {}): Promise<string[]> {
  const grace = opts.graceMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const reg = opts.runRegistry;
  const todoSync = opts.todoSync;
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
    // #22 bg-watchdog: transition the linked TODO so a worker that exited without a terminal
    // record doesn't leave its fleet TODO stuck in_progress forever. markRunTodoReverted with
    // priorStatus=undefined reverts a fleet-created TODO to open (retryable) + appends the
    // reason note. (The link path only accepts open/in_progress TODOs, so reverting to open is
    // the correct recovery for a linked one too — its prior was open/in_progress.)
    if (meta.todoId && todoSync) {
      try {
        await todoSync.markRunTodoReverted(meta.todoId, undefined, "WORKER_EXITED_WITHOUT_RESULT: process gone (probe)");
      } catch { /* best-effort: the run is already marked aborted in the log + registry */ }
    }
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
