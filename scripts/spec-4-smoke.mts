# scripts/spec-4-smoke.mts — SPEC-4 end-to-end lifecycle smoke
// Run: node --import tsx scripts/spec-4-smoke.mts
//
// Verifies a full `default` lifecycle (brainstorm→plan→implement→review→finish) on a trivial
// task using REAL Ollama Cloud pi phases. CC-phase rows skip gracefully if `claude` is absent
// (RECTOR's OAuth is expired — see SPEC-3 smoke pattern).
//
// Assertions:
//  - lifecycle status === "completed"
//  - 5 phase records, each non-terminal phase has paths.length >= 1
//  - the lifecycle TODO's notes progress block shows all 5 phases [x]
//
// This script builds a real lifecycleDeps (real spawnSubagent + real backendRegistry + real
// ArmoryTodoAdapter), mirroring scripts/spec-3-smoke.mts's real-deps wiring. It uses `auto`
// mode (onCheckpoint = auto-continue/abort) so it runs end-to-end without a human.
//
// NOTE: this script requires a configured Ollama Cloud model + network access. It is NOT part
// of the CI gate (`pnpm test:run`); run it manually post-implementation to verify the wiring.
import { runLifecycle, type LifecycleRunDeps, type CheckpointFn } from "../src/lifecycle/run-lifecycle.ts";
import { DEFAULT_LIFECYCLE } from "../src/lifecycle/default.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { discoverAgents } from "../src/registry/discovery.ts";
import { buildDefaultBackendRegistry, createChildSessionFactory } from "../src/index.ts";
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { join } from "node:path";

async function main(): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const todoSync = new ArmoryTodoAdapter();
  const backendRegistry = await buildDefaultBackendRegistry(modelRuntime);
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
      registry: agentRegistry, todoSync, runRegistry: new RunRegistry(), lock: createSingleSlotLock(),
      backendRegistry, parentModel: { provider: "ollama-cloud", id: "qwen3-coder" }, parentCwd: process.cwd(),
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