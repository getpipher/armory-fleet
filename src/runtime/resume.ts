// src/runtime/resume.ts
// SPEC-5a §5.3 — on pi start, scan .pi/fleet/runs/ for non-terminal journals and offer resume.
// If the worktree is gone, mark the journal run:aborted (worktree-missing).
import { RunJournal, type JournalEvent } from "./run-journal.ts";
import type { WorktreeService } from "../worktree/worktree-service.ts";

export interface ResumeCandidate {
  runId: string;
  task: string;
  lifecycle: string;
  /** Present only for isolated (worktree) runs. */
  worktreePath?: string;
  /** Present only for isolated (worktree) runs. */
  branch?: string;
  lastPhase: string | null;
  canResume: boolean;
}

export interface ScanResumeOpts {
  runsDir: string;
  worktree: WorktreeService;
}

export function scanResumeCandidates(_projectDir: string, opts: ScanResumeOpts): ResumeCandidate[] {
  const journal = new RunJournal(opts.runsDir);
  const ids = journal.scanNonTerminal();
  const cands: ResumeCandidate[] = [];
  for (const runId of ids) {
    const events = journal.replay(runId);
    const started = events.find((e) => e.type === "run:started") as
      | (JournalEvent & { type: "run:started"; worktree?: { path: string; branch: string } }) | undefined;
    if (!started) continue;
    const phaseEvents = events.filter((e) => e.type === "phase:completed" || e.type === "phase:started" || e.type === "phase:failed") as Array<{ phase: string }>;
    const lastPhase = phaseEvents.length > 0 ? phaseEvents[phaseEvents.length - 1]!.phase : null;

    if (started.worktree) {
      // isolated run: resume iff the worktree still exists
      const wtExists = opts.worktree.exists(runId);
      if (!wtExists) {
        journal.append(runId, { type: "run:aborted", runId, reason: "worktree-missing", ts: Date.now() });
      }
      cands.push({
        runId, task: started.task, lifecycle: started.lifecycle,
        worktreePath: started.worktree.path, branch: started.worktree.branch,
        lastPhase, canResume: wtExists,
      });
    } else {
      // v0.11.1: in-place interrupted run — no worktree to clean; abort (partial edits may remain in cwd).
      journal.append(runId, { type: "run:aborted", runId, reason: "in-place interrupted (partial edits may remain in cwd)", ts: Date.now() });
      cands.push({ runId, task: started.task, lifecycle: started.lifecycle, lastPhase, canResume: false });
    }
  }
  return cands;
}