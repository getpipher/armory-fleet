// scripts/spec-5a-bg-fail-repro.mts — focused repro for the bg-run-immediate-failure.
// Run: node --import tsx scripts/spec-5a-bg-fail-repro.mts
//
// Mirrors the TUI's asyncRunLifecycle adapter (index.ts): real createChildSessionFactory +
// spawnSubagent + worktree + artifactDiscovery (DiffService). Fires one bg run, polls the
// journal for run:aborted/run:completed within 15s, prints the surfaced error.
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
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "fleet-bg-fail-"));
  execSync("git init -b main", { cwd: repo });
  execSync('git config user.email "t@t.test" && git config user.name "test"', { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "base\n");
  execSync("git add base.txt && git commit -m base", { cwd: repo });
  console.log("repro repo:", repo);

  const modelRuntime = await ModelRuntime.create();
  const todoSync = new ArmoryTodoAdapter();
  const resumeStore = new ResumeStore();
  const memoryPort = new ArmoryMemoryAdapter();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register({ id: "pi", factory: createChildSessionFactory(modelRuntime, memoryPort, resumeStore), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  const agentRegistry = discoverAgents({ projectDir: join(repo, ".pi", "agents"), globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"), builtinDir: join(new URL(".", import.meta.url).pathname, "..", "agents") }).agents;

  const runRegistry = new RunRegistry();
  const lock = createSingleSlotLock();   // the foreground single-slot
  const diff = new DiffService();

  // Simulate the TUI condition: a foreground subagent is running + holds the foreground lock.
  // Before the fix, the bg adapter passed `lock: deps.lock` to bg spawns, so tryAcquire failed
  // fast ("concurrency lock unexpectedly unavailable" → 6ms run:aborted). Hold it for the whole
  // repro to prove the bg run no longer contends with it.
  lock.tryAcquire("fl-fg-held");
  console.log("foreground lock held by fl-fg-held for the whole repro (simulates a running fg subagent)");

  // Mirror the TUI's asyncRunLifecycle adapter (index.ts ~line 172) — INCLUDING worktreePath +
  // artifactDiscovery (the worktree-diff path), which the spec-5a-smoke.mts script omits.
  const journal = new RunJournal(join(repo, ".pi", "fleet", "runs"));
  const inbox = new ResultsInbox();
  const asyncDeps = {
    worktree: new WorktreeService({ rootDir: repo }),
    diff,
    journal,
    pool: new ConcurrencyPool(2),
    inbox,
    runLifecycle: async (task: string, lifecycleName: string, opts: any) => {
      // FIX (SPEC-5a §8.1): fresh per-bg-run lock so bg spawns don't contend with the foreground lock.
      const bgLock = createSingleSlotLock();
      const res = await runLifecycle(task, lifecycleName, {
        deps: {
          registry: new Map([["default", DEFAULT_LIFECYCLE]]),
          agentRegistry,
          spawn: async (o: any) => spawnSubagent({ agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model, skillsOverride: o.skills, backendOverride: o.backend, registry: agentRegistry, todoSync, runRegistry, lock: bgLock, backendRegistry, parentModel: { provider: "Ollama", id: "glm-5.2:cloud" }, parentCwd: opts.worktreePath }),
          todoPort: todoSync,
          resolveBackend: (phaseBackend: any, lifecycleBackend: any) => phaseBackend ?? lifecycleBackend,
          genRunId: () => opts.runId,
          artifactDiscovery: ({ finalText, cwd, baseRef }: { finalText: string; cwd: string; baseRef: string }) => {
            try {
              return diff.diffPhase(cwd, baseRef, finalText);
            } catch (e) {
              // Inspect the worktree state to diagnose the "Not a git repository" failure.
              console.log("=== diffPhase failed — inspecting worktree state ===");
              try { console.log("git -C status:", execSync(`git -C ${cwd} status --porcelain 2>&1 || true`).toString()); } catch {}
              try { console.log(".git file:", execSync(`cat ${cwd}/.git 2>&1 || ls -la ${cwd}/.git 2>&1 || echo NO_GIT`).toString()); } catch {}
              try { console.log("ls worktree:", execSync(`ls -la ${cwd} 2>&1 | head -20`).toString()); } catch {}
              try { console.log("git -C rev-parse:", execSync(`git -C ${cwd} rev-parse --is-inside-work-tree 2>&1 || true`).toString()); } catch {}
              throw e;
            }
          },
        },
        mode: opts.mode,
        worktreePath: opts.worktreePath,
        baseRef: "HEAD",
        onCheckpoint: async (p: any) => p.status === "failed" ? { action: "abort" } : { action: "continue" },
      });
      return res as any;
    },
    notify: (m: string) => console.log("notify:", m),
    genRunId: () => "fl-repro-" + Date.now().toString(36),
  };

  const handle = runBackground("Add a hello() function to scratch.ts", { deps: asyncDeps as any, lifecycle: "default", mode: "auto" });
  console.log("fired:", handle.runId);

  // Poll the journal (run:aborted records immediately on fast failure; run:completed on success).
  const deadline = Date.now() + 15_000;
  let events: any[] = [];
  while (Date.now() < deadline) {
    events = journal.replay(handle.runId);
    if (events.some((e) => e.type === "run:aborted" || e.type === "run:completed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("journal events:", JSON.stringify(events, null, 2));
  const aborted = events.find((e) => e.type === "run:aborted");
  if (aborted) console.log("\n★ run:aborted reason:", aborted.reason);
  else if (events.some((e) => e.type === "run:completed")) console.log("\n★ run:completed (no failure)");
  else console.log("\n★ no terminal event within 15s (still running?)");

  rmSync(repo, { recursive: true, force: true });
}
void main().catch((e) => { console.error("REPRO ERROR:", e); process.exit(1); });