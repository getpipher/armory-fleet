// test/diff-service.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorktreeService } from "../src/worktree/worktree-service.ts";
import { DiffService } from "../src/worktree/diff-service.ts";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-test-"));
  sh("git init -b main", dir);
  sh('git config user.email "t@t.test"', dir);
  sh('git config user.name "test"', dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh("git add base.txt && git commit -m base", dir);
  return dir;
}

test("diffPhase lists tracked modifications + untracked new files", () => {
  const repo = makeRepo();
  const wt = new WorktreeService({ rootDir: repo });
  const diff = new DiffService();
  const { path } = wt.create("fl-diff1", "HEAD");
  appendFileSync(join(path, "base.txt"), "more\n");
  writeFileSync(join(path, "design.md"), "# design\n");
  const res = diff.diffPhase(path, "HEAD");
  assert.ok(res.paths.includes("base.txt"), `paths: ${res.paths.join(",")}`);
  assert.ok(res.paths.includes("design.md"), `paths: ${res.paths.join(",")}`);
  wt.remove("fl-diff1");
  rmSync(repo, { recursive: true, force: true });
});

test("diffPhase returns empty paths when nothing changed", () => {
  const repo = makeRepo();
  const wt = new WorktreeService({ rootDir: repo });
  const diff = new DiffService();
  const { path } = wt.create("fl-diff2", "HEAD");
  const res = diff.diffPhase(path, "HEAD");
  assert.equal(res.paths.length, 0);
  wt.remove("fl-diff2");
  rmSync(repo, { recursive: true, force: true });
});

test("summary is a truncated form of the provided child final text", () => {
  const repo = makeRepo();
  const wt = new WorktreeService({ rootDir: repo });
  const diff = new DiffService();
  const { path } = wt.create("fl-diff3", "HEAD");
  writeFileSync(join(path, "x.txt"), "x\n");
  const long = "This is a long summary that should be truncated to a reasonable length so the phase record stays small even if the child wrote a wall of text that goes well beyond two hundred characters and keeps going and going and going to make sure we hit the cap and exercise the truncation path with an ellipsis at the end.";
  const res = diff.diffPhase(path, "HEAD", long);
  assert.ok(res.summary.length <= 200, `summary len ${res.summary.length}`);
  assert.ok(res.summary.startsWith("This is a long summary"));
  assert.ok(res.summary.endsWith("…"));
  wt.remove("fl-diff3");
  rmSync(repo, { recursive: true, force: true });
});