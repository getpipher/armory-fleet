// scripts/spec-4-smoke.mts — SPEC-4 end-to-end lifecycle smoke
// Run: node --import tsx scripts/spec-4-smoke.mts
//
// Verifies a full `default` lifecycle (brainstorm→plan→implement→review→finish) on a trivial
// task using REAL Ollama Cloud pi phases. CC-phase rows skip gracefully if `claude` is absent.
// Uses `auto` mode (onCheckpoint = auto-continue/abort) so it runs end-to-end without a human.
//
// Requires a configured Ollama Cloud model + network access. NOT part of the CI gate; run manually.
import { runLifecycle, type LifecycleRunDeps, type CheckpointFn } from "../src/lifecycle/run-lifecycle.ts";
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
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

async function main(): Promise<void> {
  // Isolate the smoke in a temp cwd so the lifecycle's child sessions write their artifacts
  // (design docs, plans, code) to a throwaway dir, NOT this repo (a prior run landed scratch
  // files in main via the finish phase's commit — see cleanup commit history).
  const smokeCwd = mkdtempSync(join(tmpdir(), "fleet-spec4-smoke-"));
  console.log("smoke cwd:", smokeCwd);
  const modelRuntime = await ModelRuntime.create();
  const todoSync = new ArmoryTodoAdapter();
  const resumeStore = new ResumeStore();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register({
    id: "pi",
    factory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter(), resumeStore),
    available: () => true,
    versionInfo: () => null,
    hookParity: PI_HOOK_PARITY,
  });

  const agentDiscovery = discoverAgents({
    projectDir: join(process.cwd(), ".pi", "agents"),
    globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"),
    builtinDir: join(new URL(".", import.meta.url).pathname, "..", "agents"),
  });
  const agentRegistry = agentDiscovery.agents;

  const lifecycleDeps: LifecycleRunDeps = {
    registry: new Map([["default", DEFAULT_LIFECYCLE]]),
    agentRegistry,
    spawn: async (o) => spawnSubagent({
      agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
      skillsOverride: o.skills, backendOverride: o.backend,
      registry: agentRegistry, todoSync, runRegistry: new RunRegistry(), lock: createSingleSlotLock(),
      backendRegistry, parentModel: { provider: "Ollama", id: "glm-5.2:cloud" }, parentCwd: smokeCwd,
    }),
    todoPort: todoSync,
    resolveBackend: (phaseBackend, lifecycleBackend) => phaseBackend ?? lifecycleBackend,
    genRunId: () => "fl-smoke-" + Date.now().toString(36),
  };

  const onCheckpoint: CheckpointFn = async (phase) => phase.status === "failed" ? { action: "abort" } : { action: "continue" };
  const res = await runLifecycle(
    "Add a hello() function to a scratch file scripts/scratch-hello.ts that returns 'hello from fleet'",
    "default",
    { deps: lifecycleDeps, mode: "auto", onCheckpoint },
  );

  console.log("lifecycle result:", res.status, res.runId);
  for (const p of res.phases) {
    console.log(`  ${p.name}: ${p.status} (reviseCount=${p.reviseCount}) paths=${p.paths.join(", ")}`);
  }

  if (res.status !== "completed") {
    console.error("SMOKE FAILED: lifecycle did not complete:", res.error);
    process.exit(1);
  }
  if (res.phases.length !== 5) {
    console.error("SMOKE FAILED: expected 5 phases, got", res.phases.length);
    process.exit(1);
  }
  for (let i = 0; i < res.phases.length - 1; i++) {
    const p = res.phases[i]!;
    if (p.status !== "completed" || p.paths.length < 1) {
      console.error(`SMOKE FAILED: non-terminal phase '${p.name}' did not produce artifacts`);
      process.exit(1);
    }
  }
  console.log("SMOKE PASSED ✅");
}

void main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });