import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent, type ChildSession, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import { TierRegistry } from "../src/tiers/tier-registry.ts";
import type { ModelRegistryLike } from "../src/tiers/resolve.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string, logDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "fleet-tier-")); logDir = mkdtempSync(join(tmpdir(), "fleet-tlog-")); process.env.TODO_DIR = tmpDir; });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); delete process.env.TODO_DIR; });

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({ name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x", ...over });
const PARENT = { provider: "p", id: "m" };
const mr = (windows: Record<string, number>): ModelRegistryLike => ({ find: (pr, id) => { const w = windows[`${pr}/${id}`]; return w != null ? { contextWindow: w } : undefined; } });
function regWith(factory: ChildSessionFactory): BackendRegistry { const r = new BackendRegistry(); r.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY }); return r; }

function fakeChild(usage: { input: number; output: number; cost: number; totalTokens?: number }, assistantText = "done"): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }], usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, totalTokens: usage.totalTokens ?? (usage.input + usage.output), cost: { total: usage.cost } } } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0 });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
}

test("tier run: costTotal + contextTokens accumulated; tier recorded on RunRecord", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild({ input: 100, output: 42, cost: 0.001 }), model: "Ollama/glm-5.2:cloud" }) };
  const tiers = new TierRegistry({ tiers: [{ name: "standard", models: ["Ollama/glm-5.2:cloud"] }], agents: new Map() });
  const runReg = new RunRegistry();
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, registry: new Map([["g", agent({ tier: "standard" })]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(), backendRegistry: regWith(factory),
    parentModel: PARENT, parentCwd: tmpDir, tierRegistry: tiers, modelRegistry: mr({ "Ollama/glm-5.2:cloud": 256000 }),
  } as any);
  strictEqual(res.status, "completed");
  strictEqual(runReg.get(res.runId)!.tier, "standard");
  strictEqual(runReg.get(res.runId)!.costTotal, 0.001, "$ accumulated from usage.cost.total");
  strictEqual(runReg.get(res.runId)!.contextTokens, 142, "contextTokens = calcContextTokens(usage)");
});

test("fallback: models[0] create() rejects → retry models[1]", async () => {
  let calls = 0;
  const factory: ChildSessionFactory = { create: async () => { calls++; if (calls === 1) throw new Error("provider down"); return { session: fakeChild({ input: 10, output: 5, cost: 0 }), model: "Ollama/minimax-m3:cloud" }; } };
  const tiers = new TierRegistry({ tiers: [{ name: "std", models: ["Ollama/primary", "Ollama/fallback"] }], agents: new Map() });
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, registry: new Map([["g", agent({ tier: "std" })]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: regWith(factory),
    parentModel: PARENT, parentCwd: tmpDir, tierRegistry: tiers, modelRegistry: mr({ "Ollama/primary": 128000, "Ollama/fallback": 128000 }),
  } as any);
  strictEqual(res.status, "completed", "fallback model succeeded");
  strictEqual(calls, 2, "create() called twice (primary rejected, fallback ok)");
});

test("cap abort: costTotal > tier.costCap → aborted + budget_exceeded", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild({ input: 100, output: 42, cost: 0.01 }), model: "anthropic/claude-sonnet-4" }) };
  const tiers = new TierRegistry({ tiers: [{ name: "frontier", models: ["anthropic/claude-sonnet-4"], costCap: 0.001 }], agents: new Map() });
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, registry: new Map([["g", agent({ tier: "frontier" })]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: regWith(factory),
    parentModel: PARENT, parentCwd: tmpDir, tierRegistry: tiers, modelRegistry: mr({ "anthropic/claude-sonnet-4": 200000 }),
  } as any);
  strictEqual(res.status, "aborted");
  ok(res.error?.includes("budget_exceeded"), `error mentions budget_exceeded: ${res.error}`);
});

test("no tier (agent.model path): cost still tracked, no cap enforcement", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild({ input: 100, output: 42, cost: 0.5 }), model: "m" }) };
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, registry: new Map([["g", agent({ model: "m" })]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: regWith(factory),
    parentModel: PARENT, parentCwd: tmpDir, tierRegistry: new TierRegistry({ tiers: [], agents: new Map() }), modelRegistry: mr({}),
  } as any);
  strictEqual(res.status, "completed", "no cap → runs to completion even at $0.5");
  strictEqual(res.tokenTotal, 142);
});

test("tierOverride: overrides agent tier before model resolution", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild({ input: 10, output: 5, cost: 0 }), model: "Ollama/override-model:cloud" }) };
  const tiers = new TierRegistry({ tiers: [
    { name: "standard", models: ["Ollama/standard-model:cloud"] },
    { name: "high", models: ["Ollama/override-model:cloud"] },
  ], agents: new Map() });
  const runReg = new RunRegistry();
  // Agent def has tier: "standard" but spawnSubagent gets tierOverride: "high"
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, registry: new Map([["g", agent({ tier: "standard" })]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(), backendRegistry: regWith(factory),
    parentModel: PARENT, parentCwd: tmpDir, tierRegistry: tiers, modelRegistry: mr({ "Ollama/standard-model:cloud": 128000, "Ollama/override-model:cloud": 200000 }),
    tierOverride: "high",
  } as any);
  strictEqual(res.status, "completed", "tierOverride resolved to high tier");
  strictEqual(runReg.get(res.runId)!.tier, "high", "run record tier = high (overridden)");
});
