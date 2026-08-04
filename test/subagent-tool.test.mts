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
  create: async () => {
    // Per-call handlers array (NOT module-level) so tests are isolated — a module-level global
    // would accumulate handlers across tests and replay events to stale registries (test-isolation
    // bug the PR #30 review caught). A realistic child emits ≥1 assistant message_end.
    const handlers: Array<(e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[]; stopReason?: string } }) => void> = [];
    return {
      session: {
        prompt: async () => {
          for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
        },
        subscribe: (h: (e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[]; stopReason?: string } }) => void) => { handlers.push(h); return () => {}; },
        abort: async () => {},
        dispose: () => {},
      },
      model: "m",
    };
  },
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
    lifecycleRegistry: new Map(),
    lifecycleRuns: new Map(),
    lifecycleDeps: {
      registry: new Map(),
      agentRegistry: new Map(),
      todoPort: new ArmoryTodoAdapter(),
      resolveBackend: (_p: any, lb: any) => lb,
      genRunId: () => "fl-test",
    },
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

test("subagent background with isolation:'worktree' in a non-git cwd returns isError synchronously", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub-nogit-"));
  const fakeAsyncRunner = {
    worktree: { isGitRepo: () => false, create: () => { throw new Error("no"); }, removeWorktree: () => {}, remove: () => {}, exists: () => false, branchFor: () => "fleet/x", pathFor: () => plain },
    diff: {}, journal: { append: () => {}, replay: () => [], scanNonTerminal: () => [] },
    pool: { withSlot: async () => {} }, inbox: { push: () => {}, readyCount: () => 0, pull: () => [], renderHint: () => "" },
    runLifecycle: async () => ({ status: "completed", phases: [] } as any),
    notify: () => {}, genRunId: () => "fl-x",
  } as any;
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", background: true, isolation: "worktree" } as any, new AbortController().signal, () => {}, {} as any);
  ok(res.isError === true, `expected isError, got: ${(res as any).isError}`);
  ok(/requires a git repo/.test((res.content as any)[0].text), `text: ${(res.content as any)[0].text}`);
  rmSync(plain, { recursive: true, force: true });
});

test("subagent background default (auto) in a non-git cwd returns a background run (in-place)", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub-nogit2-"));
  const fakeAsyncRunner = {
    worktree: { isGitRepo: () => false, create: () => { throw new Error("no"); }, removeWorktree: () => {}, remove: () => {}, exists: () => false, branchFor: () => "fleet/x", pathFor: () => plain },
    diff: {}, journal: { append: () => {}, replay: () => [], scanNonTerminal: () => [] },
    pool: { withSlot: async () => {} }, inbox: { push: () => {}, readyCount: () => 0, pull: () => [], renderHint: () => "" },
    runLifecycle: async () => ({ status: "completed", phases: [] } as any),
    notify: () => {}, genRunId: () => "fl-auto",
  } as any;
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", background: true } as any, new AbortController().signal, () => {}, {} as any);
  ok(res.isError === undefined, `expected no isError, got: ${(res as any).isError}`);
  ok(/background run:/.test((res.content as any)[0].text), `text: ${(res.content as any)[0].text}`);
  rmSync(plain, { recursive: true, force: true });
});
