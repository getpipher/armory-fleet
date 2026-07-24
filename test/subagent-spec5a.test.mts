// test/subagent-spec5a.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createSubagentTool, type SubagentToolDeps } from "../src/tools/subagent.ts";
import { WorktreeService } from "../src/worktree/worktree-service.ts";
import { DiffService } from "../src/worktree/diff-service.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { ConcurrencyPool } from "../src/runtime/concurrency-pool.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";
import { Scheduler } from "../src/scheduling/scheduler.ts";

function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8" }).trim(); }

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-test-"));
  sh("git init -b main", dir);
  sh('git config user.email "t@t.test"', dir);
  sh('git config user.name "test"', dir);
  writeFileSync(join(dir, "base.txt"), "base\n");
  sh("git add base.txt && git commit -m base", dir);
  return dir;
}

// Build a minimal SubagentToolDeps with only the SPEC-5a surfaces (asyncRunner + scheduler).
// The background/schedule routing paths don't touch the foreground deps.
function makeDeps(repo: string): { deps: SubagentToolDeps; scheduler: Scheduler } {
  const scheduler = new Scheduler({
    storePath: join(repo, ".pi", "fleet", "schedules.json"),
    lockPath: join(repo, ".pi", "fleet", "schedules.lock"),
    onFire: () => {},
  });
  const asyncRunner = {
    worktree: new WorktreeService({ rootDir: repo }),
    diff: new DiffService(),
    journal: new RunJournal(join(repo, ".pi", "fleet", "runs")),
    pool: new ConcurrencyPool(2),
    inbox: new ResultsInbox(),
    runLifecycle: async (_task: string, lifecycleName: string, opts: { runId: string; worktreePath: string; branch: string; mode: "auto" | "checkpointed" }) => ({
      runId: opts.runId, lifecycleName, task: _task, backend: "pi", mode: "auto", status: "completed" as const,
      phases: [{ name: "brainstorm", status: "completed", summary: "s", paths: [], reviseCount: 0 }],
      startedAt: 1, endedAt: 2, todoId: "td-x",
    }),
    notify: () => {},
    genRunId: () => "fl-tool-" + Math.random().toString(36).slice(2, 6),
  };
  // The foreground deps are unused by the background/schedule paths; cast a minimal stub.
  const deps = {
    registry: new Map(),
    runRegistry: { add: () => {}, get: () => undefined, update: () => {}, all: () => [] } as any,
    lock: { acquire: () => true, release: () => {} } as any,
    todoSync: {} as any,
    backendRegistry: {} as any,
    parentModel: { provider: "Ollama", id: "glm-5.2:cloud" },
    parentCwd: repo,
    lifecycleRegistry: new Map(),
    lifecycleRuns: new Map(),
    lifecycleDeps: {} as any,
    asyncRunner,
    scheduler,
  } as unknown as SubagentToolDeps;
  return { deps, scheduler };
}

test("background:true returns { runId, status: 'background' } without awaiting", async () => {
  const repo = makeRepo();
  const { deps } = makeDeps(repo);
  const tool = createSubagentTool(deps);
  const res: any = await tool.execute("callid", { agent: "general-purpose", task: "t", background: true } as any, new AbortController().signal, undefined, {});
  assert.equal(res.details.status, "background");
  assert.ok(res.details.runId.startsWith("fl-tool-"));
  rmSync(repo, { recursive: true, force: true });
});

test("schedule:'30m' returns { scheduleId, nextFire }", async () => {
  const repo = makeRepo();
  const { deps } = makeDeps(repo);
  const tool = createSubagentTool(deps);
  const res: any = await tool.execute("callid", { agent: "general-purpose", task: "t", schedule: "30m" } as any, new AbortController().signal, undefined, {});
  assert.ok(res.details.scheduleId.startsWith("sch-"));
  assert.ok(res.details.nextFire instanceof Date);
  rmSync(repo, { recursive: true, force: true });
});

test("background + schedule together → actionable error", async () => {
  const repo = makeRepo();
  const { deps } = makeDeps(repo);
  const tool = createSubagentTool(deps);
  const res: any = await tool.execute("callid", { agent: "general-purpose", task: "t", background: true, schedule: "30m" } as any, new AbortController().signal, undefined, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /pass only one|inherently background/);
  rmSync(repo, { recursive: true, force: true });
});