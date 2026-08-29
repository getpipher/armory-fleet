// test/spawn-subagent-runlog.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
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
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, userMemory: false,
  backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
});

/** A fake child that emits session_init + a turn (turn_start, message_end, tool_execution_end, turn_end). */
function fakeChild(backendSessionId: string, assistantText: string, tool: { name: string; args: string; result: string; isError: boolean } | null): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId });
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }], usage: { input: 100, output: 42, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });
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
  // SPEC-6-2: the optimistic pre-session_init run:meta was removed (double-write dedup);
  // now a single run:meta is written after session_init, carrying backendSessionId.
  strictEqual(types.filter((t) => t === "run:meta").length, 1, "one run:meta event (post-session_init, dedup)");
  ok(types.indexOf("message") < types.indexOf("tool"), "message before tool");
  ok(types[types.length - 1] === "run:ended", "last event is run:ended");
  const meta = events.find((e) => e.type === "run:meta") as any;
  strictEqual(meta.backendSessionId, "sess-1", "session_init bound into run:meta");
  const ended = events[events.length - 1] as any;
  strictEqual(ended.status, "completed");
  strictEqual(ended.tokenTotal, 142, "real tokens accumulated (input+output+cacheRead+cacheWrite), not cost.total dollars");
  strictEqual(h.runRegistry.get(res.runId)!.tokenTotal, 142, "RunRegistry live tokenTotal (the 5b-2 widget seam)");
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
test("#59: run:ended carries the failure reason (error) on failed runs", async () => {
  // The archived #59 failing runs had run:ended with empty resultSummary and NO error field —
  // post-hoc diagnosis from the journal was impossible. The failure reason must be journaled.
  const handlers: Array<(e: any) => void> = [];
  const errChild: ChildSession = {
    prompt: async () => { for (const h of handlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "quota exhausted" }] } }); },
    subscribe: (h: any) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errChild, model: "m" }) };
  const log = new RunLog(logDir);
  const h = harness(factory, log);
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, runLog: log,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "failed");
  const ended = log.replay(res.runId).at(-1) as any;
  strictEqual(ended.type, "run:ended");
  ok(typeof ended.error === "string" && ended.error.includes("quota exhausted"), `run:ended.error present + meaningful: ${ended.error}`);
});

test("#61: toolCallCount lands on SpawnResult + run:ended (executed-tool count)", async () => {
  const handlers: Array<(e: any) => void> = [];
  const toolChild: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId: "s61" });
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false });
      for (const h of handlers) h({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: "ok", isError: false });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h: any) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: toolChild, model: "m" }) };
  const log = new RunLog(logDir);
  const h = harness(factory, log);
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true, runLog: log,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  strictEqual(res.toolCallCount, 2, "SpawnResult.toolCallCount counts executed tools");
  const ended = log.replay(res.runId).at(-1) as any;
  strictEqual(ended.toolCallCount, 2, "run:ended carries toolCallCount");
});

test("#61: completed run with ZERO tool calls → toolCallCount 0 (the premature-return signal)", async () => {
  const handlers: Array<(e: any) => void> = [];
  const narrateOnlyChild: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me read the files first." }] } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h: any) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: narrateOnlyChild, model: "m" }) };
  const h = harness(factory, new RunLog(logDir));
  const res = await spawnSubagent({
    agent: "g", task: "implement a big feature", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  strictEqual(res.toolCallCount, 0, "zero executed tools is the #61 degenerate shape");
});

test("#61: claude-path counting — mapped CC tool_use lines yield toolCallCount > 0 (no false zero-work flag)", async () => {
  // End-to-end over the claude event mapping: a claude child's assistant NDJSON line, mapped
  // through mapClaudeEvents, must produce tool events the engine counts — a completed claude
  // run that DID work must never be flagged as a zero-tool premature return.
  const { mapClaudeEvents } = await import("../src/backend/claude-events.ts");
  const ccLine = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Editing now" },
        { type: "tool_use", id: "toolu_a", name: "Edit", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  });
  const handlers: Array<(e: any) => void> = [];
  const claudeChild: ChildSession = {
    prompt: async () => {
      for (const ev of mapClaudeEvents(ccLine)) for (const h of handlers) h(ev);
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h: any) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: claudeChild, model: "claude" }) };
  const h = harness(factory, new RunLog(logDir));
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  strictEqual(res.status, "completed");
  ok((res.toolCallCount ?? 0) >= 2, `claude tools counted (no false premature-return): ${res.toolCallCount}`);
});

test("#61 follow-up: claude tool_use input feeds filesTouched (Edit block path extracted)", async () => {
  const { mapClaudeEvents } = await import("../src/backend/claude-events.ts");
  const ccLine = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Editing" },
        { type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
      ],
    },
  });
  const handlers: Array<(e: any) => void> = [];
  const claudeChild: ChildSession = {
    prompt: async () => {
      for (const ev of mapClaudeEvents(ccLine)) for (const h of handlers) h(ev);
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h: any) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: claudeChild, model: "claude" }) };
  const h = harness(factory, new RunLog(logDir));
  const res = await spawnSubagent({
    agent: "g", task: "t", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: h.backendRegistry,
    parentModel: PARENT, parentCwd: tmpDir,
  });
  deepStrictEqual(res.filesTouched, ["/repo/src/a.ts"], "claude Edit blocks contribute to filesTouched (#49 parity)");
});
