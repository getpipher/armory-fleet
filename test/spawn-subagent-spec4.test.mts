import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { spawnSubagent, type ChildSessionFactory, type ChildSession, type ChildSessionEvent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";
import type { TodoSyncPort } from "../src/todo-sync/port.ts";

/** Fake child session that immediately emits a completed assistant message. */
function fakeSession(finalText: string): ChildSession {
  return {
    prompt: async () => {},
    subscribe: (h) => {
      h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      return () => {};
    },
    abort: async () => {}, dispose: () => {},
  };
}

const factory = (finalText: string): ChildSessionFactory => ({
  async create() { return { session: fakeSession(finalText), model: "test/model" }; },
});

function fakeBackend(finalText: string): Backend {
  return { id: "pi", factory: factory(finalText), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
}

const agent: AgentDef = {
  name: "general-purpose", description: "x", rolePrompt: "", todoSync: true, memoryHydrate: false, vision: false,
  backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x.md",
};

/** Fake todo port that records every call. */
function recordingPort(): TodoSyncPort & { calls: string[] } {
  const calls: string[] = [];
  const port: TodoSyncPort = {
    async linkOrCreateRunTodo(run) { calls.push(`link:${run.todoId ?? "create"}`); return { todoId: run.todoId ?? "td-created" }; },
    async markRunTodoDone() { calls.push("markDone"); },
    async markRunTodoReverted() { calls.push("markReverted"); },
    async updateLifecycleProgress() { calls.push("progress"); },
  };
  return Object.assign(port, { calls });
}

test("lifecycle child spawn links to the lifecycle todoId + does NOT mark-done/revert", async () => {
  const port = recordingPort();
  const reg = new RunRegistry();
  const lock = createSingleSlotLock();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register(fakeBackend("done\n\nArtifacts:\n  - path: x.ts\n"));
  const res = await spawnSubagent({
    agent: "general-purpose", task: "t", lifecycleTodoId: "td-lifecycle",
    registry: new Map([["general-purpose", agent]]), todoSync: port, runRegistry: reg, lock, backendRegistry,
    parentModel: { provider: "test", id: "model" }, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  ok(port.calls.includes("link:td-lifecycle"), "linked to the lifecycle todoId (did not create)");
  ok(!port.calls.includes("markDone"), "lifecycle child skips mark-done (lifecycle engine owns status)");
  ok(!port.calls.includes("markReverted"), "lifecycle child skips mark-revert");
});

test("non-lifecycle spawn still creates + marks done (regression)", async () => {
  const port = recordingPort();
  const reg = new RunRegistry();
  const lock = createSingleSlotLock();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register(fakeBackend("done"));
  await spawnSubagent({
    agent: "general-purpose", task: "t",
    registry: new Map([["general-purpose", agent]]), todoSync: port, runRegistry: reg, lock, backendRegistry,
    parentModel: { provider: "test", id: "model" }, parentCwd: "/tmp",
  });
  ok(port.calls.includes("link:create"), "no lifecycleTodoId → creates a fleet task (regression guard)");
  ok(port.calls.includes("markDone"), "non-lifecycle spawn marks done (regression guard)");
});
test("skillsOverride + backendOverride are honored by spawnSubagent (Q1=B + Q4=C)", async () => {
  // agentDef has backend=pi + no skills; overrides force backend=claude + skills=[brainstorming].
  // We assert the factory receives the cloned agent with the override skills + that the backend
  // registry is queried for "claude" (not "pi"). Use a factory that records the agent.skills it gets.
  let receivedSkills: string[] | undefined;
  let receivedBackendId = "";
  const recFactory: ChildSessionFactory = {
    async create(opts) {
      receivedSkills = opts.agent.skills;
      return { session: fakeSession("done\n\nArtifacts:\n  - path: x.ts\n"), model: "test/model" };
    },
  };
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: recFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  reg.register({ id: "claude", factory: recFactory, available: () => true, versionInfo: () => null, hookParity: CLAUDE_HOOK_PARITY });
  // track which backend was looked up by giving claude a distinct factory that records the id
  const claudeFactory: ChildSessionFactory = {
    async create(opts) { receivedSkills = opts.agent.skills; receivedBackendId = "claude"; return { session: fakeSession("done\n\nArtifacts:\n  - path: x.ts\n"), model: "cc" }; },
  };
  reg.register({ id: "claude", factory: claudeFactory, available: () => true, versionInfo: () => null, hookParity: CLAUDE_HOOK_PARITY });
  const port = recordingPort();
  const res = await spawnSubagent({
    agent: "general-purpose", task: "t", lifecycleTodoId: "td-lc",
    skillsOverride: ["brainstorming"], backendOverride: "claude",
    registry: new Map([["general-purpose", { ...agent, backend: "pi", skills: undefined }]]),
    todoSync: port, runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg,
    parentModel: { provider: "test", id: "model" }, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(receivedBackendId, "claude", "routed to the overridden claude backend, not the agent's pi");
  ok(receivedSkills !== undefined && receivedSkills.includes("brainstorming"), "factory received the overridden skills");
});
