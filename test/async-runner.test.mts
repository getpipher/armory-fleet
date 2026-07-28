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
  const handle = runBackground("add hello", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(handle.status, "background");
  const { runId } = handle;
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
  const h = runBackground("bad task", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h.status, "background");
  const { runId } = h;
  await new Promise((r) => setTimeout(r, 60));
  const events = journal.replay(runId);
  assert.ok(events.some((e) => e.type === "run:aborted"), "no run:aborted");
  assert.equal(wt.exists(runId), false, "worktree not cleaned up");
  assert.ok(notifications.some((n) => /failed|error/i.test(n)), `notifications: ${notifications.join("|")}`);
  rmSync(repo, { recursive: true, force: true });
});

test("runBackground isolation:'none' runs in-place in a NON-GIT dir, journals run:started with no worktree, completes, pushes result with no branch", async () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit-"));
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.equal(opts.worktreePath, undefined, "in-place run must not receive a worktreePath");
    writeFileSync(join(plain, "out.txt"), "done\n");
    return {
      runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "implement", status: "completed", summary: "did it", paths: ["out.txt"], reviseCount: 0 }],
      startedAt: 1, endedAt: 2, todoId: "td-x",
    };
  };
  const { deps, journal, inbox, notifications } = makeDeps(plain, fakeLifecycle);
  const handle = runBackground("research x", { deps, lifecycle: "default", mode: "auto", isolation: "none" });
  assert.equal(handle.status, "background");
  assert.ok("runId" in handle, "in-place handle has a runId");
  await new Promise((r) => setTimeout(r, 60));
  const events = journal.replay(handle.runId);
  const started = events.find((e) => e.type === "run:started") as any;
  assert.equal(started.worktree, undefined, "in-place run:started must omit worktree");
  assert.ok(events.some((e) => e.type === "run:completed"), "no run:completed");
  const completed = events.find((e) => e.type === "run:completed") as any;
  assert.equal(completed.branch, undefined, "in-place run:completed must omit branch");
  assert.equal(inbox.readyCount(), 1);
  assert.equal(inbox.pull()[0]!.branch, undefined, "in-place result has no branch");
  assert.ok(notifications.some((n) => /completed/.test(n)), `notifications: ${notifications.join("|")}`);
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground isolation:'worktree' in a NON-GIT dir returns a SYNCHRONOUS failed result (no runId, no async toast, no 90s poll)", () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit2-"));
  const fakeLifecycle: RunLifecycleFn = async () => ({ runId: "x", lifecycleName: "x", task: "x", backend: "pi", mode: "auto", status: "completed", phases: [], startedAt: 1, endedAt: 2, todoId: null });
  const { deps, notifications } = makeDeps(plain, fakeLifecycle);
  const handle = runBackground("edit x", { deps, lifecycle: "default", mode: "auto", isolation: "worktree" });
  assert.equal(handle.status, "failed");
  assert.ok(!("runId" in handle), "sync-fail must NOT return a runId");
  assert.ok(/requires a git repo/.test((handle as any).error), `error: ${(handle as any).error}`);
  // No run was started → no async toast fires for this runId
  assert.equal(notifications.length, 0, "sync-fail must not emit an async notify");
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground default (auto) in a NON-GIT dir falls back to in-place + emits ONE per-session fallback notify", () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit3-"));
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => ({
    runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
    phases: [{ name: "implement", status: "completed", summary: "s", paths: [], reviseCount: 0 }],
    startedAt: 1, endedAt: 2, todoId: null,
  });
  const { deps, notifications } = makeDeps(plain, fakeLifecycle);
  // first auto-fallback run → 1 notify
  const h1 = runBackground("a", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h1.status, "background");
  // second auto-fallback run → no additional notify (per-session dedup)
  const h2 = runBackground("b", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h2.status, "background");
  const fallbackNotes = notifications.filter((n) => /in-place|worktree isolation/.test(n));
  assert.equal(fallbackNotes.length, 1, `expected exactly 1 fallback notify, got: ${notifications.join("|")}`);
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground default (auto) in a GIT dir stays isolated (no fallback notify) — regression guard", async () => {
  const repo = makeRepo();
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.ok(opts.worktreePath, "git auto run must receive a worktreePath");
    writeFileSync(join(opts.worktreePath!, "d.md"), "# d\n");
    return { runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "brainstorm", status: "completed", summary: "s", paths: ["d.md"], reviseCount: 0 }], startedAt: 1, endedAt: 2, todoId: "t" };
  };
  const { deps, notifications } = makeDeps(repo, fakeLifecycle);
  const h = runBackground("x", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h.status, "background");
  assert.ok("runId" in h);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(notifications.filter((n) => /in-place|worktree isolation/.test(n)).length, 0, "git auto must not fallback-notify");
  rmSync(repo, { recursive: true, force: true });
});

test("runBackground isolation:'none' in a GIT dir runs in-place (explicit opt-out, no notify)", async () => {
  const repo = makeRepo();
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.equal(opts.worktreePath, undefined, "explicit none must not receive a worktreePath");
    return { runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "implement", status: "completed", summary: "s", paths: [], reviseCount: 0 }], startedAt: 1, endedAt: 2, todoId: null };
  };
  const { deps, journal, notifications } = makeDeps(repo, fakeLifecycle);
  const h = runBackground("ro", { deps, lifecycle: "default", mode: "auto", isolation: "none" });
  assert.equal(h.status, "background");
  await new Promise((r) => setTimeout(r, 60));
  const started = journal.replay(h.runId).find((e) => e.type === "run:started") as any;
  assert.equal(started.worktree, undefined);
  assert.equal(notifications.filter((n) => /in-place|worktree isolation/.test(n)).length, 0, "explicit none must not fallback-notify");
  rmSync(repo, { recursive: true, force: true });
});