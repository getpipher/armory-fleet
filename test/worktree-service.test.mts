// test/worktree-service.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorktreeService } from "../src/worktree/worktree-service.ts";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  sh("git init -b main", dir);
  sh('git config user.email "t@t.test"', dir);
  sh('git config user.name "test"', dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh("git add base.txt && git commit -m base", dir);
  return dir;
}

test("create makes a worktree at .pi/fleet/worktrees/<runId> branched from HEAD", () => {
  const repo = makeRepo();
  const svc = new WorktreeService({ rootDir: repo });
  const { path, branch } = svc.create("fl-test1", "HEAD");
  assert.equal(branch, "fleet/fl-test1");
  assert.equal(existsSync(join(path, "base.txt")), true);
  assert.equal(svc.exists("fl-test1"), true);
  assert.equal(sh("git rev-parse --abbrev-ref HEAD", path), "fleet/fl-test1");
  rmSync(repo, { recursive: true, force: true });
});

test("create writes a new file in the worktree without affecting the main checkout", () => {
  const repo = makeRepo();
  const svc = new WorktreeService({ rootDir: repo });
  const { path } = svc.create("fl-test2", "HEAD");
  writeFileSync(join(path, "new.txt"), "new\n");
  assert.equal(existsSync(join(repo, "new.txt")), false);
  assert.equal(existsSync(join(path, "new.txt")), true);
  rmSync(repo, { recursive: true, force: true });
});

test("remove deletes the worktree + branch", () => {
  const repo = makeRepo();
  const svc = new WorktreeService({ rootDir: repo });
  const { path } = svc.create("fl-test3", "HEAD");
  svc.remove("fl-test3");
  assert.equal(svc.exists("fl-test3"), false);
  assert.equal(existsSync(path), false);
  const branches = sh("git branch --list", repo);
  assert.equal(branches.includes("fleet/fl-test3"), false);
  rmSync(repo, { recursive: true, force: true });
});

test("create errors actionable when base ref is invalid", () => {
  const repo = makeRepo();
  const svc = new WorktreeService({ rootDir: repo });
  assert.throws(() => svc.create("fl-test4", "no-such-ref"), /no-such-ref|unknown revision|invalid|worktree create failed/);
  rmSync(repo, { recursive: true, force: true });
});

test("removeWorktree removes the worktree dir but KEEPS the branch (SPEC-5a completed-run cleanup)", () => {
  const repo = makeRepo();
  const svc = new WorktreeService({ rootDir: repo });
  const { path, branch } = svc.create("fl-wt-keep", "HEAD");
  writeFileSync(join(path, "new.txt"), "x\n");
  svc.removeWorktree("fl-wt-keep");
  assert.equal(svc.exists("fl-wt-keep"), false);
  assert.equal(existsSync(path), false);
  // branch MUST still exist (kept for merge/inspection)
  const branches = sh("git branch --list", repo);
  assert.ok(branches.includes(branch), `branch ${branch} should be kept, got: ${branches}`);
  rmSync(repo, { recursive: true, force: true });
});
