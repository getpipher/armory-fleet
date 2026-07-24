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

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-engine-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g", backend: "pi" | "claude" = "pi"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true,
  backend, sessionKey: name, source: "builtin", filePath: "/x",
});

/** Fake child that emits a session_init + N turns + finalText. */
function fakeChild(sessionId: string, turns: number, finalText: string): ChildSession {
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  let aborted = false;
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId: sessionId });
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

function factoryWith(sessionId: string): ChildSessionFactory {
  return { async create(opts) { return { session: fakeChild(sessionId, 1, "done"), model: opts.model ?? "m" }; } };
}

function registryWith(backendId: "pi" | "claude", factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: backendId, factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

test("engine routes by agentDef.backend through the registry", async () => {
  const runReg = new RunRegistry();
  let called: string | null = null;
  const ccFactory: ChildSessionFactory = { async create(opts) { called = "cc"; return { session: fakeChild("cc-1", 1, "ok"), model: opts.model ?? "" }; } };
  const reg = registryWith("claude", ccFactory);
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "claude")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  strictEqual(called, "cc");
  strictEqual(res.status, "completed");
});

test("session_init event stamps runRecord.backendSessionId + sessionKey", async () => {
  const runReg = new RunRegistry();
  const reg = registryWith("pi", factoryWith("pi-sess-42"));
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "pi")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  const rec = runReg.get(res.runId)!;
  strictEqual(rec.backendSessionId, "pi-sess-42");
  strictEqual(rec.sessionKey, "g");
});

test("unavailable backend fails fast with an actionable error", async () => {
  const runReg = new RunRegistry();
  const reg = new BackendRegistry();
  reg.register({ id: "claude", factory: factoryWith("x"), available: () => false, versionInfo: () => ({ version: "1", schemaOk: false, flagSupport: {}, note: "schema drift" }), hookParity: PI_HOOK_PARITY });
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "claude")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  strictEqual(res.status, "failed");
  ok(/backend 'claude' unavailable/i.test(res.error ?? ""));
});