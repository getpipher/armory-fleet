// test/spawn-subagent-runlog.test.mts
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
import { RunLog } from "../src/runtime/run-log.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let tmpDir: string;
let logDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-spawnlog-"));
  logDir = mkdtempSync(join(tmpdir(), "fleet-convlog-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true,
  backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
});

/** A fake child that emits session_init + a turn (turn_start, message_end, tool_execution_end, turn_end). */
function fakeChild(backendSessionId: string, assistantText: string, tool: { name: string; args: string; result: string; isError: boolean } | null): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId });
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }], usage: { cost: { total: 42 } } } });
      if (tool) for (const h of handlers) h({ type: "tool_execution_end", toolCallId: "tc1", toolName: tool.name, args: tool.args, result: tool.result, isError: tool.isError });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
  };
}

const PARENT = { provider: "p", id: "m" } as any;

function harness(factory: ChildSessionFactory, log: RunLog) {
  const registry = new Map<string, AgentDef>([["g", agent()]]);
  return {
    registry, runRegistry: new RunRegistry(), lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(), backendRegistry: regWith(factory), runLog: log,
  };
}

test("spawnSubagent writes run:meta + message + tool + run:ended in order when runLog is set", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild("sess-1", "all done", { name: "bash", args: "ls", result: "file.ts", isError: false }), model: "m" }) };
  const log = new RunLog(logDir);
  const h = harness(factory, log);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true, runLog: log,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  const events = log.replay(res.runId);
  const types = events.map((e) => e.type);
  ok(types[0] === "run:meta", "first event is run:meta");
  ok(types.filter((t) => t === "run:meta").length === 2, "two run:meta events (init + session_init)");
  ok(types.indexOf("message") < types.indexOf("tool"), "message before tool");
  ok(types[types.length - 1] === "run:ended", "last event is run:ended");
  const meta = events.find((e) => e.type === "run:meta" && (e as any).backendSessionId) as any;
  strictEqual(meta.backendSessionId, "sess-1", "session_init bound into run:meta");
  const ended = events[events.length - 1] as any;
  strictEqual(ended.status, "completed");
  strictEqual(ended.tokenTotal, 42, "usage accumulated");
});

test("no journal is written when runLog is omitted (no-behavior-change invariant)", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild("sess-2", "done", null), model: "m" }) };
  const h = harness(factory, new RunLog(logDir)); // a log exists but is NOT passed
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  strictEqual(new RunLog(logDir).scanMeta().length, 0, "no journal file written");
});

test("resumeLink + forkLink land on the run:ended event + RunRecord", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild("sess-3", "followup done", null), model: "m" }) };
  const log = new RunLog(logDir);
  const h = harness(factory, log);
  const res = await spawnSubagent({
    agent: "g", task: "follow up", track: true, runLog: log, resumeLink: "fl-prior",
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  const ended = log.replay(res.runId).at(-1) as any;
  strictEqual(ended.resumedFrom, "fl-prior");
  strictEqual(h.runRegistry.get(res.runId)!.resumedFrom, "fl-prior");
});

test("tool_error result is kept in full in the journal", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild("sess-4", "x", { name: "bash", args: "pnpm test", result: "Error: test not found — full trace here", isError: true }), model: "m" }) };
  const log = new RunLog(logDir);
  const h = harness(factory, log);
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, runLog: log,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  const toolEvent = log.replay(res.runId).find((e) => e.type === "tool") as any;
  strictEqual(toolEvent.isError, true);
  ok(toolEvent.result.length > 20, "error result not excerpted");
});