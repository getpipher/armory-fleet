// src/worktree/diff-service.ts
// SPEC-5a §7 — worktree-diff artifact discovery for isolated runs (Q3=A).
// All changes in the worktree vs base: tracked modifications + untracked new files.
import { execSync } from "node:child_process";

export interface PhaseArtifacts {
  paths: string[];
  summary: string;
}

/** SPEC-5a robustness: the error variant when the worktree git state is corrupted (e.g. child
 *  ran rm -rf .git). runLifecycle treats this as a failed phase (clean abort) instead of an
 *  unhandled throw. Matches the artifactDiscovery union in run-lifecycle.ts. */
export interface PhaseArtifactsError {
  error: string;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).toString();
}

const MAX_SUMMARY = 200;

export class DiffService {
  /**
   * Compute a phase's artifacts = all changes in the worktree vs baseRef.
   * Tracked modifications via `git diff --name-only`; untracked new files via
   * `git status --porcelain` (?? entries). Deduped + sorted.
   *
   * @param childFinalText  the child's final text, truncated to MAX_SUMMARY chars as the prose summary.
   */
  diffPhase(worktreePath: string, baseRef: string, childFinalText = ""): PhaseArtifacts | PhaseArtifactsError {
    // SPEC-5a robustness: a child can corrupt its worktree's git state (e.g. rm -rf .git,
    // git init over the worktree link). Catch git failures + return {error} so runLifecycle
    // treats it as a failed phase (clean abort with surfaced cause) instead of an unhandled
    // throw crashing the async runner. Empty diff (no changes) is NOT an error — returns paths: [].
    let tracked: string[] = [];
    let status = "";
    try {
      tracked = sh(`git diff --name-only ${baseRef} --`, worktreePath).split("\n").filter(Boolean);
      status = sh("git status --porcelain", worktreePath);
    } catch (e) {
      return { error: `worktree diff failed: ${(e as Error).message.split("\n").filter(Boolean).pop() ?? (e as Error).message}` };
    }
    const untracked = status
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3).trim());
    const paths = Array.from(new Set([...tracked, ...untracked])).sort();
    const summary = childFinalText.length > MAX_SUMMARY
      ? childFinalText.slice(0, MAX_SUMMARY - 1) + "…"
      : childFinalText;
    return { paths, summary };
  }
}