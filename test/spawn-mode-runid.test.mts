// test/spawn-mode-runid.test.mts — SPEC-6-4 Task 2: runId?/mode? opts surface on run:meta.
// Fixture copied from test/spawnSubagent.test.mts (harness + regWith + fakeChild + agent):
// a FAKE child session, never a real model — CI has no providers.
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent, type ChildSession, type ChildSessionEvent, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";
import { RunLog } from "../src/runtime/run-log.ts";

function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-spawn-mode-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, userMemory: false, backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
});

function fakeChild(turns: number, finalText: string): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  let aborted = false;
  return {
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        if (i === 0) for (const h of handlers) h({ type: "session_init", backendSessionId: "sess-1" } as unknown as ChildSessionEvent);
        for (const h of handlers) h({ type: "turn_end" });
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; },
    dispose: () => {},
  };
}

function harness(factory: ChildSessionFactory, agentDef: AgentDef = agent()) {
  const registry = new Map<string, AgentDef>([[agentDef.name, agentDef]]);
  const runRegistry = new RunRegistry();
  return {
    registry, runRegistry,
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    factory,
  };
}

const PARENT = { provider: "p", id: "m" } as any;

test("spawnSubagent honors runId? + mode? opts on the run:meta event", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "done"), model: "m" }) };
  const h = harness(factory);
  const runLog = new RunLog(join(tmpDir, "conversations"));
  const metas: Array<Record<string, unknown>> = [];
  runLog.subscribe((_runId, e) => { if (e.type === "run:meta") metas.push(e as unknown as Record<string, unknown>); });
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp", runLog,
    runId: "fl-preminted", mode: "background",
  });
  strictEqual(res.runId, "fl-preminted");
  strictEqual(metas.length, 1);
  strictEqual(metas[0]!["runId"], "fl-preminted");
  strictEqual(metas[0]!["mode"], "background");
});

test("spawnSubagent defaults mode to foreground and mints a runId when absent", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "done"), model: "m" }) };
  const h = harness(factory);
  const runLog = new RunLog(join(tmpDir, "conversations"));
  const metas: Array<Record<string, unknown>> = [];
  runLog.subscribe((_runId, e) => { if (e.type === "run:meta") metas.push(e as unknown as Record<string, unknown>); });
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp", runLog,
  });
  ok(res.runId, "runId must be minted");
  strictEqual(res.runId, metas[0]!["runId"]);
  strictEqual(metas[0]!["mode"], "foreground");
});
