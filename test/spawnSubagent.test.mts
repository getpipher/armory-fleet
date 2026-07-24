// test/spawnSubagent.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodo } from "@getpipher/armory-todo";
import { spawnSubagent, type ChildSession, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-engine-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, source: "builtin", filePath: "/x",
});

/** A fake child that emits N turns then finishes with finalText. */
function fakeChild(turns: number, finalText: string): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  let aborted = false;
  return {
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        for (const h of handlers) h({ type: "turn_end" });
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; },
    dispose: () => {},
  };
}

function harness(childFactory: ChildSessionFactory, agentDef: AgentDef = agent()) {
  const registry = new Map<string, AgentDef>([[agentDef.name, agentDef]]);
  const runRegistry = new RunRegistry();
  return {
    registry, runRegistry,
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    childFactory,
  };
}

const PARENT = { provider: "p", id: "m" } as any;

test("completes + creates a fleet task + marks done", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(3, "all done"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(res.finalText, "all done");
  ok(res.todoId, "fleet task created");
  strictEqual(getTodo(res.todoId!).status, "done");
});

test("turn-budget exhaustion -> failed + partial result + todo reverted to open", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(25, "partial"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "loop", track: true, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("turn budget"), res.error);
  strictEqual(getTodo(res.todoId!).status, "open");
});

test("unknown agent -> failed with actionable message listing available", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "x"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "nope", task: "x", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("not in registry"), res.error);
  ok(res.error!.includes("available:"), res.error);
});

test("concurrency=1: second concurrent call is rejected with running id", async () => {
  let releasePrompt: () => void = () => {};
  let enteredResolver: () => void = () => {};
  const enteredPrompt = new Promise<void>((r) => { enteredResolver = r; });
  const slowChild: ChildSession = {
    prompt: () => { enteredResolver(); return new Promise<void>((res) => { releasePrompt = res; }); },
    subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: slowChild, model: "m" }) };
  const h = harness(factory);
  const p1 = spawnSubagent({
    agent: "g", task: "long", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  const res2 = await spawnSubagent({
    agent: "g", task: "second", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res2.status, "failed");
  ok(res2.error!.includes("already running"), res2.error);
  ok(/fl-/.test(res2.error!), "names the running runId");
  await enteredPrompt; // p1 has reached session.prompt -> releasePrompt is now the real resolver
  releasePrompt();
  await p1;
});

test("track:false touches no todo", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.todoId, null);
  strictEqual(res.status, "completed");
});

test("todo excluded from child tools (fleet is single writer)", async () => {
  let captured: any;
  const factory: ChildSessionFactory = {
    create: async (opts) => { captured = opts; return { session: fakeChild(1, "ok"), model: "m" }; },
  };
  const a = agent("g"); a.tools = ["read", "bash", "todo", "edit"];
  const h = harness(factory, a);
  await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: PARENT, parentCwd: "/tmp",
  });
  ok(!captured.tools.includes("todo"), "todo stripped");
  ok(captured.tools.includes("read"), "read kept");
});