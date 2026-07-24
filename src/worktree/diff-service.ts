// src/worktree/diff-service.ts
// SPEC-5a §7 — worktree-diff artifact discovery for isolated runs (Q3=A).
// All changes in the worktree vs base: tracked modifications + untracked new files.
import { execSync } from "node:child_process";

export interface PhaseArtifacts {
  paths: string[];
  summary: string;
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
  diffPhase(worktreePath: string, baseRef: string, childFinalText = ""): PhaseArtifacts {
    const tracked = sh(`git diff --name-only ${baseRef} --`, worktreePath)
      .split("\n")
      .filter(Boolean);
    const status = sh("git status --porcelain", worktreePath);
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