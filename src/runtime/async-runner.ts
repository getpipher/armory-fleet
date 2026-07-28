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
  worktreePath?: string;
  branch?: string;
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
  /** v0.11.1: edit isolation for background runs. Default "auto" (worktree when cwd is a git repo, in-place otherwise). */
  isolation?: Isolation;
}

/** The success shape (back-compat: existing external refs to RunBackgroundHandle still typecheck). */
export interface RunBackgroundHandle { runId: string; status: "background"; }

/** v0.11.1: a background dispatch either starts (runId + background) or fails synchronously (error, no runId). */
export type RunBackgroundResult =
  | { runId: string; status: "background" }
  | { status: "failed"; error: string };

export type Isolation = "worktree" | "none" | "auto";

/** Per-session dedup flag for the auto-fallback in-place notify (resets on process restart = new session). */
let inPlaceFallbackWarned = false;

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

/** The git-agnostic core: pool slot → journal → runLifecycle in ctx.cwd (or a worktree, when `isolated` is set) → inbox + notify.
 *  Fire-and-forget. When `isolated` is present, journals the worktree field, commits on completion, and removes the worktree. */
function runBackgroundInPlace(runId: string, task: string, opts: RunBackgroundOpts, isolated?: { worktreePath: string; branch: string }): void {
  const { deps } = opts;
  void deps.pool.withSlot(async () => {
    try {
      const ev0: JournalEvent = isolated
        ? { type: "run:started", runId, task, lifecycle: opts.lifecycle, worktree: { path: isolated.worktreePath, branch: isolated.branch }, mode: opts.mode, ts: Date.now() }
        : { type: "run:started", runId, task, lifecycle: opts.lifecycle, mode: opts.mode, ts: Date.now() };
      deps.journal.append(runId, ev0);
      emitProgress(deps, runId, { status: "running", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });

      const res = await deps.runLifecycle(task, opts.lifecycle, { runId, worktreePath: isolated?.worktreePath, branch: isolated?.branch, mode: opts.mode });

      if (res.status === "completed") {
        if (isolated) {
          try { sh("git add -A && git commit -m 'fleet run complete'", isolated.worktreePath); } catch { /* nothing to commit */ }
        }
        deps.journal.append(runId, isolated
          ? { type: "run:completed", runId, branch: isolated.branch, ts: Date.now() }
          : { type: "run:completed", runId, ts: Date.now() });
        const total = res.phases.length;
        const lastIdx = total;
        emitProgress(deps, runId, { status: "completed", phase: res.phases[total - 1]?.name ?? "finish", phaseIndex: lastIdx, phaseTotal: total, lifecycle: opts.lifecycle, mode: opts.mode, task, ...(isolated ? { branch: isolated.branch } : {}) });
        const lastPhase = res.phases[res.phases.length - 1];
        const result: RunResult = {
          runId, task, status: "completed",
          summary: lastPhase?.summary ?? "",
          paths: res.phases.flatMap((p) => p.paths),
          completedAt: Date.now(),
          ...(isolated ? { branch: isolated.branch } : {}),
        };
        deps.inbox.push(result);
        deps.notify(`fleet run ${runId} completed`, "info");
        if (isolated) deps.worktree.removeWorktree(runId);
      } else {
        deps.journal.append(runId, { type: "run:aborted", runId, reason: res.error ?? res.status, ts: Date.now() });
        if (isolated) deps.worktree.remove(runId);
        emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: res.phases.length, lifecycle: opts.lifecycle, mode: opts.mode, task });
        deps.notify(`fleet run ${runId} ${res.status}: ${res.error ?? ""}`, "warning");
      }
    } catch (e) {
      const msg = (e as Error).message;
      deps.journal.append(runId, { type: "run:aborted", runId, reason: msg, ts: Date.now() });
      if (isolated) deps.worktree.remove(runId);
      deps.notify(`fleet run ${runId} failed: ${msg}`, "error");
      emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });
    }
  });
}

/** The worktree wrapper: SYNCHRONOUS pre-flight + worktree create, then core-with-isolation. */
function runBackgroundIsolated(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const { deps } = opts;
  if (!deps.worktree.isGitRepo()) {
    return { status: "failed", error: "isolation: 'worktree' requires a git repo; cwd is not one — use isolation: 'none' or run in a git repo" };
  }
  const runId = deps.genRunId();
  const baseRef = "HEAD";
  let wt: { path: string; branch: string };
  try {
    wt = deps.worktree.create(runId, baseRef);
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
  runBackgroundInPlace(runId, task, opts, { worktreePath: wt.path, branch: wt.branch });
  return { runId, status: "background" };
}

/** The auto router: isolated when cwd is a git repo, in-place + one per-session notify when not. */
function runBackgroundAuto(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const { deps } = opts;
  if (deps.worktree.isGitRepo()) {
    return runBackgroundIsolated(task, opts);
  }
  if (!inPlaceFallbackWarned) {
    inPlaceFallbackWarned = true;
    deps.notify("background run in-place (no worktree isolation — parallel edits may conflict)", "warning");
  }
  const runId = deps.genRunId();
  runBackgroundInPlace(runId, task, opts);
  return { runId, status: "background" };
}

/** Public dispatcher (keeps the `runBackground` name + RunBackgroundHandle success shape for back-compat). */
export function runBackground(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const isolation = opts.isolation ?? "auto";
  if (isolation === "worktree") return runBackgroundIsolated(task, opts);
  if (isolation === "none") {
    const runId = opts.deps.genRunId();
    runBackgroundInPlace(runId, task, opts);
    return { runId, status: "background" };
  }
  return runBackgroundAuto(task, opts);
}