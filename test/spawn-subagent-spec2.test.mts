// spawn-subagent-spec2.test.mts — threads memoryPort + visionPort to the child factory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSubagent, type ChildSession } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const agent: AgentDef = { name: "general-purpose", description: "", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, source: "builtin", filePath: "x" };
const memPort = { renderScopes: () => "## Memory\nblock" } as any;
const visPort = { isMultimodal: () => false, isConfigured: () => true, delegate: async () => ({ ok: true, text: "desc" }) } as any;

function fakeChild(): ChildSession {
  return {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
  };
}

test("spawnSubagent threads memoryPort + visionPort to the child factory", async () => {
  let received: any = {};
  const factory = {
    async create(opts: any) {
      received = opts;
      return { session: fakeChild(), model: "ollama/qwen3" };
    },
  };
  const res = await spawnSubagent({
    agent: "general-purpose",
    task: "do it",
    track: false,
    registry: new Map([["general-purpose", agent]]),
    todoSync: new ArmoryTodoAdapter() as any,
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    childFactory: factory as any,
    parentModel: { provider: "ollama", id: "qwen3" },
    parentCwd: "/proj",
    memoryPort: memPort,
    visionPort: visPort,
  } as any);
  assert.equal(res.status, "completed");
  assert.equal(received.memoryPort, memPort, "memoryPort threaded to factory");
  assert.equal(received.visionPort, visPort, "visionPort threaded to factory");
  assert.equal(received.agent.name, "general-purpose", "agent (AgentDef) threaded to factory");
});

test("spawnSubagent passes agent tools through unfiltered (excludeTools is the factory's job)", async () => {
  let received: any;
  const factory = { async create(opts: any) { received = opts; return { session: fakeChild(), model: "m" }; } };
  const a = { ...agent, name: "g", tools: ["read", "bash", "todo", "edit"] };
  await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: new Map([["g", a]]),
    todoSync: new ArmoryTodoAdapter() as any,
    runRegistry: new RunRegistry(), lock: createSingleSlotLock(), childFactory: factory as any,
    parentModel: { provider: "p", id: "m" }, parentCwd: "/tmp",
  } as any);
  assert.ok(received.tools.includes("todo"), "todo passes through unfiltered; factory applies excludeTools");
  assert.ok(received.tools.includes("read"));
});