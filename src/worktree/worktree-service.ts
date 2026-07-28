// src/worktree/worktree-service.ts
// Greenfield git worktree lifecycle (SPEC-5a §6, Q9=A — thin shell-outs, no git library).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeRef {
  path: string;
  branch: string;
}

export interface WorktreeServiceOpts {
  rootDir: string;
  /** Where worktrees live. Defaults to <rootDir>/.pi/fleet/worktrees. */
  worktreesDir?: string;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

export class WorktreeService {
  private readonly rootDir: string;
  private readonly worktreesDir: string;

  constructor(opts: WorktreeServiceOpts) {
    this.rootDir = opts.rootDir;
    this.worktreesDir = opts.worktreesDir ?? join(opts.rootDir, ".pi", "fleet", "worktrees");
  }

  branchFor(runId: string): string {
    return `fleet/${runId}`;
  }

  pathFor(runId: string): string {
    return join(this.worktreesDir, runId);
  }

  exists(runId: string): boolean {
    return existsSync(this.pathFor(runId));
  }

  /** v0.11.1: is `rootDir` (or `dir`) inside a git repo? Cheap sync pre-flight for isolation routing. */
  isGitRepo(dir: string = this.rootDir): boolean {
    try {
      sh("git rev-parse --show-toplevel", dir);
      return true;
    } catch {
      return false;
    }
  }

  create(runId: string, baseRef = "HEAD"): WorktreeRef {
    if (this.exists(runId)) {
      throw new Error(`worktree for run ${runId} already exists at ${this.pathFor(runId)}`);
    }
    mkdirSync(this.worktreesDir, { recursive: true });
    const branch = this.branchFor(runId);
    const path = this.pathFor(runId);
    try {
      sh(`git worktree add -b ${branch} ${path} ${baseRef}`, this.rootDir);
    } catch (e) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      const msg = (e as Error).message;
      const tail = msg.split("\n").filter(Boolean).pop() ?? msg;
      throw new Error(`worktree create failed for run ${runId} (base ${baseRef}): ${tail}`);
    }
    return { path, branch };
  }

  /** SPEC-5a: remove the worktree dir but KEEP the branch (for completed runs the branch is
   *  kept for merge/inspection; only the worktree dir is temporary scaffolding). */
  removeWorktree(runId: string): void {
    const path = this.pathFor(runId);
    if (existsSync(path)) {
      try {
        sh(`git worktree remove --force ${path}`, this.rootDir);
      } catch {
        rmSync(path, { recursive: true, force: true });
        try { sh("git worktree prune", this.rootDir); } catch { /* ignore */ }
      }
    }
  }

  remove(runId: string): void {
    const path = this.pathFor(runId);
    const branch = this.branchFor(runId);
    if (existsSync(path)) {
      try {
        sh(`git worktree remove --force ${path}`, this.rootDir);
      } catch {
        rmSync(path, { recursive: true, force: true });
        try { sh("git worktree prune", this.rootDir); } catch { /* ignore */ }
      }
    }
    try {
      sh(`git branch -D ${branch}`, this.rootDir);
    } catch {
      // branch may not exist; ignore
    }
  }
}