// scripts/spec-5a-smoke.mts — SPEC-5a end-to-end operational-runtime smoke
// Run: node --import tsx scripts/spec-5a-smoke.mts
//
// Verifies the full SPEC-5a path on REAL Ollama Cloud pi phases in an isolated temp git repo:
//   1. runBackground fires a trivial isolated lifecycle → worktree created → phases run →
//      worktree-diff discovers artifacts → journal records events → inbox receives result → notify.
//   2. A one-shot schedule fires + auto-deletes.
// The worktree IS the isolation (no repo pollution, unlike the SPEC-4 smoke's temp-cwd workaround).
// Requires a configured Ollama Cloud model + ~/.pi/agent/auth.json (pi loads it automatically).
// NOT part of the CI gate; run manually before tagging v0.5.0.
import { runLifecycle } from "../src/lifecycle/run-lifecycle.ts";
import { DEFAULT_LIFECYCLE } from "../src/lifecycle/default.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { discoverAgents } from "../src/registry/discovery.ts";
import { createChildSessionFactory } from "../src/index.ts";
import { BackendRegistry, PI_HOOK_PARITY } from "../src/backend/port.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { WorktreeService } from "../src/worktree/worktree-service.ts";
import { DiffService } from "../src/worktree/diff-service.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { ConcurrencyPool } from "../src/runtime/concurrency-pool.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";
import { runBackground } from "../src/runtime/async-runner.ts";
import { Scheduler } from "../src/scheduling/scheduler.ts";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

async function main(): Promise<void> {
  // 1. isolated temp git repo (the worktree IS the isolation — no repo pollution)
  const repo = mkdtempSync(join(tmpdir(), "fleet-spec5a-smoke-"));
  execSync("git init -b main", { cwd: repo });
  execSync('git config user.email "t@t.test" && git config user.name "test"', { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "base\n");
  execSync("git add base.txt && git commit -m base", { cwd: repo });
  console.log("smoke repo:", repo);

  // 2. build the same lifecycleDeps as the SPEC-4 smoke
  const modelRuntime = await ModelRuntime.create();
  const todoSync = new ArmoryTodoAdapter();
  const resumeStore = new ResumeStore();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register({ id: "pi", factory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter(), resumeStore), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  const agentDiscovery = discoverAgents({ projectDir: join(repo, ".pi", "agents"), globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"), builtinDir: join(new URL(".", import.meta.url).pathname, "..", "agents") });
  const agentRegistry = agentDiscovery.agents;

  const lifecycleDeps = {
    registry: new Map([["default", DEFAULT_LIFECYCLE]]),
    agentRegistry,
    spawn: async (o: any) => spawnSubagent({ agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model, skillsOverride: o.skills, backendOverride: o.backend, registry: agentRegistry, todoSync, runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry, parentModel: { provider: "Ollama", id: "glm-5.2:cloud" }, parentCwd: o.parentCwd }),
    todoPort: todoSync,
    resolveBackend: (phaseBackend: any, lifecycleBackend: any) => phaseBackend ?? lifecycleBackend,
    genRunId: () => "fl-smoke-" + Date.now().toString(36),
  };

  // 3. async runner deps — the runLifecycle adapter maps runBackground opts → runLifecycle
  const journal = new RunJournal(join(repo, ".pi", "fleet", "runs"));
  const inbox = new ResultsInbox();
  const asyncDeps = {
    worktree: new WorktreeService({ rootDir: repo }),
    diff: new DiffService(),
    journal,
    pool: new ConcurrencyPool(2),
    inbox,
    runLifecycle: async (task: string, lifecycleName: string, opts: any) => {
      const res = await runLifecycle(task, lifecycleName, {
        deps: { ...lifecycleDeps, spawn: async (o: any) => lifecycleDeps.spawn({ ...o, parentCwd: opts.worktreePath }) } as any,
        mode: "auto",
        onCheckpoint: async (p) => p.status === "failed" ? { action: "abort" } : { action: "continue" },
      });
      return res as any;
    },
    notify: (m: string) => console.log("notify:", m),
    genRunId: () => "fl-smoke-" + Date.now().toString(36),
  };

  // 4. fire a background run
  const handle = runBackground("Add a hello() function to scratch.ts returning 'hello from fleet'", { deps: asyncDeps, lifecycle: "default", mode: "auto" });
  console.log("fired:", handle);

  // 5. wait for completion (poll the inbox)
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && inbox.readyCount() === 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const results = inbox.pull();
  if (results.length === 0) { console.error("SMOKE FAILED: no result within 180s"); rmSync(repo, { recursive: true, force: true }); process.exit(1); }
  console.log("result:", JSON.stringify(results[0], null, 2));

  // 6. assert the journal
  const events = journal.replay(handle.runId);
  if (!events.some((e) => e.type === "run:completed")) { console.error("SMOKE FAILED: no run:completed in journal"); rmSync(repo, { recursive: true, force: true }); process.exit(1); }
  console.log("journal events:", events.map((e) => e.type).join(", "));

  // 7. scheduling: register a one-shot 2s out + assert it fires once + auto-deletes
  let schedFired = 0;
  const scheduler = new Scheduler({ storePath: join(repo, ".pi", "fleet", "schedules.json"), lockPath: join(repo, ".pi", "fleet", "schedules.lock"), onFire: () => { schedFired++; } });
  const fireAt = new Date(Date.now() + 2000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${fireAt.getFullYear()}-${pad(fireAt.getMonth() + 1)}-${pad(fireAt.getDate())}T${pad(fireAt.getHours())}:${pad(fireAt.getMinutes())}:${pad(fireAt.getSeconds())}`;
  const schedId = scheduler.register({ task: "scheduled smoke", expression: iso, lifecycle: "default" });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 3000));
  scheduler.stop();
  if (schedFired !== 1) { console.error(`SMOKE FAILED: schedule fired ${schedFired} times (expected 1)`); rmSync(repo, { recursive: true, force: true }); process.exit(1); }
  if (scheduler.list().find((s) => s.id === schedId)) { console.error("SMOKE FAILED: one-shot not auto-deleted"); rmSync(repo, { recursive: true, force: true }); process.exit(1); }
  console.log("schedule fired once + auto-deleted ✓");

  rmSync(repo, { recursive: true, force: true });
  console.log("SMOKE PASSED ✅");
}

void main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });