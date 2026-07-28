// test/async-runner.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorktreeService } from "../src/worktree/worktree-service.ts";
import { DiffService } from "../src/worktree/diff-service.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { ConcurrencyPool } from "../src/runtime/concurrency-pool.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";
import { runBackground, type RunLifecycleFn, type AsyncRunnerDeps } from "../src/runtime/async-runner.ts";

function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8" }).trim(); }

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "async-test-"));
  sh("git init -b main", dir);
  sh('git config user.email "t@t.test"', dir);
  sh('git config user.name "test"', dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh("git add base.txt && git commit -m base", dir);
  return dir;
}

function makeDeps(repo: string, runLifecycle: RunLifecycleFn): { deps: AsyncRunnerDeps; journal: RunJournal; inbox: ResultsInbox; notifications: string[] } {
  const journal = new RunJournal(join(repo, ".pi", "fleet", "runs"));
  const inbox = new ResultsInbox();
  const notifications: string[] = [];
  const deps: AsyncRunnerDeps = {
    worktree: new WorktreeService({ rootDir: repo }),
    diff: new DiffService(),
    journal,
    pool: new ConcurrencyPool(2),
    inbox,
    runLifecycle,
    notify: (m) => { notifications.push(m); },
    genRunId: () => "fl-test-" + Math.random().toString(36).slice(2, 8),
  };
  return { deps, journal, inbox, notifications };
}

test("runBackground creates a worktree, journals run:started, drives runLifecycle, journals run:completed, pushes to inbox, notifies", async () => {
  const repo = makeRepo();
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    writeFileSync(join(opts.worktreePath!, "design.md"), "# design\n");
    return {
      runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "brainstorm", status: "completed", summary: "did it", paths: ["design.md"], reviseCount: 0 }],
      startedAt: 1, endedAt: 2, todoId: "td-x",
    };
  };
  const { deps, journal, inbox, notifications } = makeDeps(repo, fakeLifecycle);
  const { runId, status } = runBackground("add hello", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(status, "background");
  await new Promise((r) => setTimeout(r, 60));
  const events = journal.replay(runId);
  assert.ok(events.some((e) => e.type === "run:started"), "no run:started");
  assert.ok(events.some((e) => e.type === "run:completed"), "no run:completed");
  assert.equal(inbox.readyCount(), 1);
  assert.ok(notifications.some((n) => n.includes("completed")), `notifications: ${notifications.join("|")}`);
  rmSync(repo, { recursive: true, force: true });
});

test("runBackground journals run:aborted + cleans up the worktree when runLifecycle fails", async () => {
  const repo = makeRepo();
  const failingLifecycle: RunLifecycleFn = async () => { throw new Error("model blew up"); };
  const { deps, journal, notifications } = makeDeps(repo, failingLifecycle);
  const wt = deps.worktree;
  const { runId } = runBackground("bad task", { deps, lifecycle: "default", mode: "auto" });
  await new Promise((r) => setTimeout(r, 60));
  const events = journal.replay(runId);
  assert.ok(events.some((e) => e.type === "run:aborted"), "no run:aborted");
  assert.equal(wt.exists(runId), false, "worktree not cleaned up");
  assert.ok(notifications.some((n) => /failed|error/i.test(n)), `notifications: ${notifications.join("|")}`);
  rmSync(repo, { recursive: true, force: true });
});