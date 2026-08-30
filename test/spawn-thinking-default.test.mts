// test/spawn-thinking-default.test.mts
// #78: fleet-wide `defaultSubagentThinking` — the engine applies it only when the
// agent frontmatter does NOT pin a thinkingLevel. Precedence:
//   agent.thinkingLevel > opts.defaultThinkingLevel > undefined (pi session default).
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent, type ChildSession, type ChildSessionEvent, type ChildSessionFactory, type ChildSessionOpts } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { AgentDef, ThinkingLevel } from "../src/registry/frontmatter.ts";

function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-thinking-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g", thinkingLevel?: ThinkingLevel): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, userMemory: false, backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
  ...(thinkingLevel ? { thinkingLevel } : {}),
});

function fakeChild(finalText: string): ChildSession {
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
  };
}

/** Factory that records the thinkingLevel each create() received. */
function capturingFactory(seen: Array<ThinkingLevel | undefined>): ChildSessionFactory {
  return {
    create: async (opts: ChildSessionOpts) => {
      seen.push(opts.thinkingLevel);
      return { session: fakeChild("done"), model: "m" };
    },
  };
}

function harness(factory: ChildSessionFactory, agentDef: AgentDef) {
  const registry = new Map<string, AgentDef>([[agentDef.name, agentDef]]);
  return {
    registry,
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    factory,
  };
}

const PARENT = { provider: "p", id: "m" } as const;

test("fleet default applies when agent has no frontmatter thinkingLevel", async () => {
  const seen: Array<ThinkingLevel | undefined> = [];
  const def = agent("g");
  const h = harness(capturingFactory(seen), def);
  const res = await spawnSubagent({
    agent: "g", task: "work", track: false, defaultThinkingLevel: "high",
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock,
    backendRegistry: regWith(h.factory), parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(seen.length, 1);
  strictEqual(seen[0], "high");
});

test("agent frontmatter thinkingLevel wins over the fleet default", async () => {
  const seen: Array<ThinkingLevel | undefined> = [];
  const def = agent("g", "low");
  const h = harness(capturingFactory(seen), def);
  const res = await spawnSubagent({
    agent: "g", task: "work", track: false, defaultThinkingLevel: "high",
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock,
    backendRegistry: regWith(h.factory), parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(seen[0], "low");
});

test("no agent level + no fleet default → factory receives undefined (pi session default)", async () => {
  const seen: Array<ThinkingLevel | undefined> = [];
  const def = agent("g");
  const h = harness(capturingFactory(seen), def);
  const res = await spawnSubagent({
    agent: "g", task: "work", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock,
    backendRegistry: regWith(h.factory), parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(seen.length, 1);
  strictEqual(seen[0], undefined);
});
