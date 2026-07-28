// src/runtime/async-runner.ts
// SPEC-5a §2/§6/§7/§8/§10 — the async/bg path. Layers ABOVE the unchanged runLifecycle:
// creates a worktree, journals events, drives runLifecycle with the worktree cwd, discovers
// artifacts via DiffService, commits on completion, pushes to the inbox, notifies.
import type { WorktreeService } from "../worktree/worktree-service.ts";
import type { DiffService } from "../worktree/diff-service.ts";
import type { RunJournal, JournalEvent } from "./run-journal.ts";
import type { ConcurrencyPool } from "./concurrency-pool.ts";
import type { ResultsInbox, RunResult } from "./results-inbox.ts";
import { execSync } from "node:child_process";

// Thin shape of the LifecycleRunResult we need (avoids importing the full type here — the
// real adapter in index.ts maps the full LifecycleRunResult to this shape).
export interface FakeLifecycleResult {
  runId: string;
  lifecycleName: string;
  task: string;
  status: "completed" | "failed" | "aborted";
  phases: Array<{ name: string; status: string; summary: string; paths: string[]; reviseCount: number }>;
  todoId: string | null;
  error?: string;
}

export interface RunLifecycleOpts {
  runId: string;
  worktreePath: string;
  branch: string;
  mode: "auto" | "checkpointed";
}

export type RunLifecycleFn = (task: string, lifecycleName: string, opts: RunLifecycleOpts) => Promise<FakeLifecycleResult>;

export interface AsyncRunnerDeps {
  worktree: WorktreeService;
  diff: DiffService;
  journal: RunJournal;
  pool: ConcurrencyPool;
  inbox: ResultsInbox;
  runLifecycle: RunLifecycleFn;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
  genRunId: () => string;
  /** SPEC-5a: called at each run/phase transition so the host (index.ts) can update the live bgRuns map. */
  onProgress?: (runId: string, status: import("../panel/rows.ts").BgRunStatus) => void;
  /** SPEC-6-2: the RunRegistry so emitProgress can read the run's actual backend. */
  runRegistry?: import("../engine/run-registry.ts").RunRegistry;
}

export interface RunBackgroundOpts {
  deps: AsyncRunnerDeps;
  lifecycle: string;
  mode: "auto" | "checkpointed";
}

export interface RunBackgroundHandle {
  runId: string;
  status: "background";
}

function emitProgress(deps: AsyncRunnerDeps, runId: string, partial: Partial<import("../panel/rows.ts").BgRunStatus> & { status: import("../panel/rows.ts").BgStatus; phase: string; phaseIndex: number; phaseTotal: number }): void {
  if (!deps.onProgress) return;
  deps.onProgress(runId, {
    runId,
    lifecycle: "",
    mode: "auto",
    backend: deps.runRegistry?.get(runId)?.backend ?? "pi",
    task: "",
    ...partial,
  });
}

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export function runBackground(task: string, opts: RunBackgroundOpts): RunBackgroundHandle {
  const { deps } = opts;
  const runId = deps.genRunId();
  const baseRef = "HEAD";

  // Fire-and-forget: the pool gates concurrency; the journal records the run.
  void deps.pool.withSlot(async () => {
    let wt: { path: string; branch: string } | null = null;
    try {
      wt = deps.worktree.create(runId, baseRef);
      const ev0: JournalEvent = { type: "run:started", runId, task, lifecycle: opts.lifecycle, worktree: { path: wt.path, branch: wt.branch }, mode: opts.mode, ts: Date.now() };
      deps.journal.append(runId, ev0);
      emitProgress(deps, runId, { status: "running", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });

      const res = await deps.runLifecycle(task, opts.lifecycle, { runId, worktreePath: wt.path, branch: wt.branch, mode: opts.mode });

      if (res.status === "completed") {
        // commit the worktree to the branch (lifecycle finish phase or single-delegate completion)
        try { sh("git add -A && git commit -m 'fleet run complete'", wt.path); } catch { /* nothing to commit */ }
        deps.journal.append(runId, { type: "run:completed", runId, branch: wt.branch, ts: Date.now() });
        const total = res.phases.length;
        const lastIdx = total; // completed = past the last phase
        emitProgress(deps, runId, { status: "completed", phase: res.phases[total - 1]?.name ?? "finish", phaseIndex: lastIdx, phaseTotal: total, lifecycle: opts.lifecycle, mode: opts.mode, task, branch: wt.branch });
        const lastPhase = res.phases[res.phases.length - 1];
        const result: RunResult = {
          runId, task, status: "completed",
          summary: lastPhase?.summary ?? "",
          paths: res.phases.flatMap((p) => p.paths),
          branch: wt.branch, completedAt: Date.now(),
        };
        deps.inbox.push(result);
        deps.notify(`fleet run ${runId} completed`, "info");
        // SPEC-5a: the worktree dir is temporary scaffolding; remove it but keep the branch for merge/inspection.
        deps.worktree.removeWorktree(runId);
      } else {
        deps.journal.append(runId, { type: "run:aborted", runId, reason: res.error ?? res.status, ts: Date.now() });
        deps.worktree.remove(runId);
        emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: res.phases.length, lifecycle: opts.lifecycle, mode: opts.mode, task });
        deps.notify(`fleet run ${runId} ${res.status}: ${res.error ?? ""}`, "warning");
      }
    } catch (e) {
      const msg = (e as Error).message;
      deps.journal.append(runId, { type: "run:aborted", runId, reason: msg, ts: Date.now() });
      if (wt) deps.worktree.remove(runId);
      deps.notify(`fleet run ${runId} failed: ${msg}`, "error");
      emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });
    }
  });

  return { runId, status: "background" };
}