// test/subagent-tool.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentTool, subagentParams } from "../src/tools/subagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const fakeFactory: ChildSessionFactory = {
  create: async () => ({
    session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} },
    model: "m",
  }),
};
function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tool-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent: AgentDef = { name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x" };

function makeDeps() {
  return {
    registry: new Map<string, AgentDef>([["g", agent]]),
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    backendRegistry: regWith(fakeFactory),
    parentModel: { provider: "p", id: "m" } as any,
    parentCwd: "/tmp",
  };
}

test("subagentParams schema has the v0.1 fields", () => {
  const keys = Object.keys(subagentParams.properties);
  ok(keys.includes("agent"), "agent");
  ok(keys.includes("task"), "task");
  ok("todoId" in subagentParams.properties, "todoId optional");
  ok("track" in subagentParams.properties, "track optional");
  ok("model" in subagentParams.properties, "model optional");
});

test("tool execute returns content text + details runId on success", async () => {
  const tool = createSubagentTool(makeDeps());
  const out = await tool.execute!("c", { agent: "g", task: "hi" }, new AbortController().signal, () => {}, {} as any);
  ok(out.content[0]!.type === "text");
  ok((out.details as any).runId, "runId in details");
  strictEqual((out.details as any).status, "completed");
  strictEqual(out.isError, false);
});

test("tool execute surfaces isError + actionable message on unknown agent", async () => {
  const tool = createSubagentTool(makeDeps());
  const out = await tool.execute!("c", { agent: "nope", task: "hi" }, new AbortController().signal, () => {}, {} as any);
  strictEqual(out.isError, true);
  ok((out.content[0] as any).text.includes("not in registry"));
});