// scripts/spec-3-smoke.mts — SPEC-3 full-run smoke (rows 2-4).
// Exercises the REAL CC backend (spawn a real `claude -p`) when claude is installed; skips cleanly otherwise.
// Run: node --import tsx scripts/spec-3-smoke.mts
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY } from "../src/backend/port.ts";
import { detectClaude } from "../src/backend/claude-detector.ts";
import { createClaudeChildFactory } from "../src/backend/claude-factory.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory } from "../src/index.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ✔ ${name}`); pass++; }
  else { console.log(`  ✖ ${name} ${detail}`); fail++; }
}

const resumeStore = new ResumeStore();
const claudeInfo = await detectClaude();
if (!claudeInfo?.schemaOk) {
  console.log("⏭  claude not available (not installed or schema drift) — skipping CC rows. Pi row 2 still runs.");
}

const runtime = await ModelRuntime.create();
const reg = new BackendRegistry();
reg.register({ id: "pi", factory: createChildSessionFactory(runtime, new ArmoryMemoryAdapter(), resumeStore), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
if (claudeInfo) reg.register({ id: "claude", factory: createClaudeChildFactory(claudeInfo, resumeStore), available: () => claudeInfo.schemaOk, versionInfo: () => claudeInfo, hookParity: CLAUDE_HOOK_PARITY });

const piAgent: AgentDef = { name: "general-purpose", description: "d", rolePrompt: "Reply minimally.", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x" };
const ccAgent: AgentDef = { name: "general-purpose-cc", description: "d", rolePrompt: "Reply minimally.", todoSync: true, memoryHydrate: true, vision: true, backend: "claude", sessionKey: "general-purpose-cc", source: "builtin", filePath: "/x" };
const registry = new Map<string, AgentDef>([["general-purpose", piAgent], ["general-purpose-cc", ccAgent]]);

// Row 2: pi backend (real Ollama Cloud session.prompt())
{
  console.log("Row 2: pi backend spawn");
  const res = await spawnSubagent({ agent: "general-purpose", task: "Reply with exactly: OK", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "Ollama", id: "glm-5.2:cloud" }, parentCwd: process.cwd() });
  check("pi run completes", res.status === "completed", res.error ?? "");
  check("pi run produced finalText", res.finalText.length > 0);
}

// Rows 3-4: CC backend + resume (only if claude available)
if (claudeInfo?.schemaOk) {
  console.log("Row 3: claude backend spawn");
  const res = await spawnSubagent({ agent: "general-purpose-cc", task: "Reply with exactly: OK", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: process.cwd() });
  check("cc run completes", res.status === "completed", res.error ?? "");
  console.log("Row 4: claude resume (re-spawn same sessionKey)");
  const res2 = await spawnSubagent({ agent: "general-purpose-cc", task: "What did I just say?", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: process.cwd() });
  check("cc resume run completes", res2.status === "completed", res2.error ?? "");
} else {
  console.log("Rows 3-4: skipped (claude unavailable)");
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);