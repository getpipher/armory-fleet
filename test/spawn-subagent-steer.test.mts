// test/spawn-subagent-steer.test.mts
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
import type { AgentDef } from "../src/registry/frontmatter.ts";

function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-steer-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true,
  backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
});

const PARENT = { provider: "p", id: "m" } as any;

/** A fake steerable child whose prompt asserts the handle is set BEFORE prompt runs. */
function steerableChild(backendSessionId: string, runRegistry: RunRegistry): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  return {
    prompt: async () => {
      const rec = runRegistry.list().find((r) => r.status === "running");
      ok(rec, "a running record exists when prompt starts");
      ok(rec!.session, "handle is set BEFORE prompt runs");
      strictEqual(rec!.session!.supportsSteer, true);
      for (const h of handlers) h({ type: "session_init", backendSessionId });
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
    steer: async (_t: string) => {},
    isStreaming: true,
  };
}

function bareChild(backendSessionId: string): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId });
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
  };
}

test("spawnSubagent sets RunRecord.session before prompt; clears it after completion", async () => {
  const runRegistry = new RunRegistry();
  const factory: ChildSessionFactory = { create: async () => ({ session: steerableChild("sess-s1", runRegistry), model: "m" }) };
  const registry = new Map<string, AgentDef>([["g", agent()]]);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true,
    registry, todoSync: new ArmoryTodoAdapter(), runRegistry, lock: createSingleSlotLock(),
    backendRegistry: regWith(factory), parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  strictEqual(runRegistry.get(res.runId)!.status, "completed");
  strictEqual(runRegistry.get(res.runId)!.session, undefined, "handle cleared after completion");
});

test("spawnSubagent: claude-style backend (no steer) → handle.supportsSteer === false", async () => {
  const runRegistry = new RunRegistry();
  const bareWithAssert: ChildSessionFactory = {
    create: async () => {
      const session = bareChild("sess-s2");
      const origPrompt = session.prompt.bind(session);
      const wrappedPrompt = async (text: string) => {
        const rec = runRegistry.list().find((r) => r.status === "running");
        ok(rec?.session, "handle set before prompt");
        strictEqual(rec!.session!.supportsSteer, false, "claude-style child has no steer");
        strictEqual(rec!.session!.isStreaming, false, "isStreaming defaults false when absent");
        await origPrompt(text);
      };
      return { session: { ...session, prompt: wrappedPrompt }, model: "m" };
    },
  };
  const registry = new Map<string, AgentDef>([["g", agent()]]);
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true,
    registry, todoSync: new ArmoryTodoAdapter(), runRegistry, lock: createSingleSlotLock(),
    backendRegistry: regWith(bareWithAssert), parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  strictEqual(runRegistry.get(res.runId)!.session, undefined, "handle cleared after completion");
});

test("spawnSubagent: aborted run clears the handle", async () => {
  const runRegistry = new RunRegistry();
  const ac = new AbortController();
  const abortingFactory: ChildSessionFactory = {
    create: async () => {
      const session = steerableChild("sess-s3", runRegistry);
      const origPrompt = session.prompt.bind(session);
      return {
        session: {
          ...session,
          prompt: async (text: string) => {
            ac.abort();
            await origPrompt(text);
          },
        },
        model: "m",
      };
    },
  };
  const registry = new Map<string, AgentDef>([["g", agent()]]);
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, signal: ac.signal,
    registry, todoSync: new ArmoryTodoAdapter(), runRegistry, lock: createSingleSlotLock(),
    backendRegistry: regWith(abortingFactory), parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "aborted");
  strictEqual(runRegistry.get(res.runId)!.session, undefined, "handle cleared after abort");
});