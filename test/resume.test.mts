// test/resume.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { WorktreeService } from "../src/worktree/worktree-service.ts";
import { scanResumeCandidates } from "../src/runtime/resume.ts";

function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8" }).trim(); }

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "resume-test-"));
  sh("git init -b main", dir);
  sh('git config user.email "t@t.test"', dir);
  sh('git config user.name "test"', dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh("git add base.txt && git commit -m base", dir);
  return dir;
}

test("scanResumeCandidates returns an interrupted run with canResume=true when the worktree exists", () => {
  const repo = makeRepo();
  const runsDir = join(repo, ".pi", "fleet", "runs");
  const journal = new RunJournal(runsDir);
  const wt = new WorktreeService({ rootDir: repo });
  const { path } = wt.create("fl-resume1", "HEAD");
  journal.append("fl-resume1", { type: "run:started", runId: "fl-resume1", task: "t", lifecycle: "default", worktree: { path, branch: "fleet/fl-resume1" }, mode: "auto", ts: 1 });
  journal.append("fl-resume1", { type: "phase:completed", phase: "brainstorm", summary: "s", paths: ["d.md"], ts: 2 });
  const cands = scanResumeCandidates(repo, { runsDir, worktree: wt });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.runId, "fl-resume1");
  assert.equal(cands[0]!.canResume, true);
  assert.equal(cands[0]!.lastPhase, "brainstorm");
  wt.remove("fl-resume1");
  rmSync(repo, { recursive: true, force: true });
});

test("scanResumeCandidates marks canResume=false + writes run:aborted when the worktree is gone", () => {
  const repo = makeRepo();
  const runsDir = join(repo, ".pi", "fleet", "runs");
  const journal = new RunJournal(runsDir);
  const wt = new WorktreeService({ rootDir: repo });
  journal.append("fl-resume2", { type: "run:started", runId: "fl-resume2", task: "t", lifecycle: "default", worktree: { path: "/gone", branch: "fleet/fl-resume2" }, mode: "auto", ts: 1 });
  const cands = scanResumeCandidates(repo, { runsDir, worktree: wt });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.canResume, false);
  const events = journal.replay("fl-resume2");
  assert.equal(events[events.length - 1]!.type, "run:aborted");
  rmSync(repo, { recursive: true, force: true });
});

test("scanResumeCandidates skips terminal runs (completed/aborted)", () => {
  const repo = makeRepo();
  const runsDir = join(repo, ".pi", "fleet", "runs");
  const journal = new RunJournal(runsDir);
  const wt = new WorktreeService({ rootDir: repo });
  journal.append("fl-resume3", { type: "run:started", runId: "fl-resume3", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-resume3" }, mode: "auto", ts: 1 });
  journal.append("fl-resume3", { type: "run:completed", runId: "fl-resume3", branch: "fleet/fl-resume3", ts: 2 });
  const cands = scanResumeCandidates(repo, { runsDir, worktree: wt });
  assert.equal(cands.length, 0);
  rmSync(repo, { recursive: true, force: true });
});

test("scanResumeCandidates aborts an interrupted IN-PLACE run (no worktree field) with canResume=false", () => {
  const repo = makeRepo();   // repo only for the WorktreeService ctor; the run is in-place
  const runsDir = join(repo, ".pi", "fleet", "runs");
  const journal = new RunJournal(runsDir);
  const wt = new WorktreeService({ rootDir: repo });
  // an in-place run: run:started with NO worktree field, no terminal event
  journal.append("fl-ip-int", { type: "run:started", runId: "fl-ip-int", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
  journal.append("fl-ip-int", { type: "phase:completed", phase: "implement", summary: "s", paths: ["x.ts"], ts: 2 });
  const cands = scanResumeCandidates(repo, { runsDir, worktree: wt });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.runId, "fl-ip-int");
  assert.equal(cands[0]!.canResume, false);
  assert.equal(cands[0]!.worktreePath, undefined);
  assert.equal(cands[0]!.branch, undefined);
  const events = journal.replay("fl-ip-int");
  assert.equal(events[events.length - 1]!.type, "run:aborted");
  rmSync(repo, { recursive: true, force: true });
});