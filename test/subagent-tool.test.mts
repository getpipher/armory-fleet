// test/subagent-tool.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSubagentTool, subagentParams, mergeLifecycleSkills } from "../src/tools/subagent.ts";
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

const agent: AgentDef = { name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, userMemory: false, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x" };

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
    defaultModelFallback: undefined as string | undefined,
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

test("#31 readOnly:true threads through the tool and bypasses the foreground lock", async () => {
  // Hold the shared lock externally (as a concurrent write dispatch would). A readOnly dispatch
  // through the tool must still complete — proving the param is threaded to spawnSubagent and
  // bypasses the lock. If the tool dropped readOnly, spawnSubagent would reject with "already running".
  const deps = makeDeps();
  const held = await deps.lock.acquire("fl-held");
  ok(held.ok, "externally hold the foreground lock");
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review", readOnly: true } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual((out.details as any).status, "completed", `readOnly dispatch should bypass the held lock; got: ${(out as any).content?.[0]?.text}`);
  strictEqual(out.isError, false);
  // The tool must NOT have released the externally-held lock.
  deepStrictEqual(deps.lock.holders(), ["fl-held"], "tool did not release the externally-held lock");
  deps.lock.release("fl-held");
});

test("#31 readOnly param is in the schema and optional", () => {
  ok("readOnly" in subagentParams.properties, "readOnly present in schema");
  // Optional => no default required; absent means write (serialized) dispatch.
  const keys = Object.keys(subagentParams.properties);
  ok(keys.includes("readOnly"), "readOnly in keys");
});

test("#32 skills param threads to the child agent's skills (skillsOverride)", async () => {
  // The subagent tool's `skills` param maps to spawnSubagent's `skillsOverride`, which clones the
  // agentDef with `skills: <override>`. The recording factory asserts the cloned agent.skills
  // equals the passed skills array (and NOT the agent's frontmatter skills, which general-purpose lacks).
  let receivedSkills: string[] | undefined;
  const recFactory: ChildSessionFactory = {
    create: async (opts) => { receivedSkills = opts.agent.skills; return { session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} }, model: "m" }; },
  };
  const deps = makeDeps();
  // swap in the recording factory via a backend registry that uses it.
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: recFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  await tool.execute!("c", { agent: "g", task: "tdd task", skills: ["test-driven-development", "verification-before-completion"] } as any, new AbortController().signal, () => {}, {} as any);
  ok(Array.isArray(receivedSkills), "factory received a skills array");
  deepStrictEqual(receivedSkills, ["test-driven-development", "verification-before-completion"], "skills param threaded to child agent.skills");
});

test("#32 skills param absent → child agent.skills stays undefined (lean: no skills loaded)", async () => {
  // Without the `skills` param, general-purpose (no frontmatter skills) must NOT get a skills array
  // — the child-loader resolves [] (the #32 lean-substrate default).
  let receivedSkills: unknown = "UNSET";
  const recFactory: ChildSessionFactory = {
    create: async (opts) => { receivedSkills = opts.agent.skills; return { session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} }, model: "m" }; },
  };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: recFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  await tool.execute!("c", { agent: "g", task: "plain" } as any, new AbortController().signal, () => {}, {} as any);
  ok(receivedSkills === undefined, `no skills override when param absent; got: ${JSON.stringify(receivedSkills)}`);
});

test("#32 skills: [] on a direct dispatch overrides the agent's frontmatter skills to zero", async () => {
  // [] is truthy → spawnSubagent clones the agent with skills: [] → resolveChildSkills → 0 skills.
  // Locks in the override-to-zero behavior (a reviewer flagged a worry this was silently ignored;
  // it isn't — [] is truthy, the clone happens).
  let receivedSkills: unknown = "UNSET";
  const recFactory: ChildSessionFactory = {
    create: async (opts) => { receivedSkills = opts.agent.skills; return { session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} }, model: "m" }; },
  };
  // Register an agent WITH frontmatter skills, then override to [] — assert the child gets [], not the frontmatter skills.
  const agentWithSkills: AgentDef = { ...agent, name: "skilled", skills: ["frontmatter-skill"] };
  const deps = makeDeps();
  deps.registry.set("skilled", agentWithSkills);
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: recFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  await tool.execute!("c", { agent: "skilled", task: "x", skills: [] } as any, new AbortController().signal, () => {}, {} as any);
  deepStrictEqual(receivedSkills, [], "skills:[] overrides frontmatter skills to zero (clone happens — [] is truthy)");
});

test("#32 mergeLifecycleSkills is additive + deduped (phase skills always load; caller adds)", () => {
  // The lifecycle spawn adapter uses mergeLifecycleSkills(o.skills, params.skills) so a caller
  // cannot strip a phase's required skills. Additive + deduped.
  deepStrictEqual(mergeLifecycleSkills(["brainstorming"], ["tdd"]), ["brainstorming", "tdd"], "phase + caller merged");
  deepStrictEqual(mergeLifecycleSkills(["brainstorming", "tdd"], ["tdd", "verify"]), ["brainstorming", "tdd", "verify"], "deduped");
  deepStrictEqual(mergeLifecycleSkills(undefined, ["tdd"]), ["tdd"], "no phase skills → caller only");
  deepStrictEqual(mergeLifecycleSkills(["brainstorming"], undefined), ["brainstorming"], "no caller skills → phase only");
  deepStrictEqual(mergeLifecycleSkills([], []), [], "both empty → empty");
});

test("#39 modelFallback: retries once on a retryable (stopReason 'error') failure with the fallback model", async () => {
  // Stateful factory: 1st create → child emits stopReason "error" (retryable fail); 2nd create
  // (the retry) → child emits a normal assistant message_end (success). Assert the tool retried
  // with the fallback model, returned the fallback's result, and marked retriedWithModel.
  let createCalls = 0;
  const errorHandlers: Array<(e: any) => void> = [];
  const okHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const okChild = {
    prompt: async () => { for (const h of okHandlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on fallback" }] } }); },
    subscribe: (h: any) => { okHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = {
    create: async () => {
      createCalls += 1;
      // 1st call (primary) returns the error child @ glm; 2nd call (retry) returns the ok child @ minimax.
      return createCalls === 1 ? { session: errorChild, model: "Ollama/glm-5.2:cloud" } : { session: okChild, model: "Ollama/minimax-m3:cloud" };
    },
  };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review", modelFallback: "Ollama/minimax-m3:cloud" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 2, "factory called twice (primary failed retryable → retried on fallback)");
  strictEqual((out.details as any).status, "completed", `retry should succeed; got: ${(out as any).content?.[0]?.text}`);
  strictEqual((out.details as any).model, "Ollama/minimax-m3:cloud", "result carries the fallback model that served the retry");
  strictEqual((out.details as any).retriedWithModel, "Ollama/minimax-m3:cloud", "retriedWithModel marks the fallback");
  strictEqual(out.isError, false);
});

test("#39 modelFallback absent: no retry — returns the failure, no retriedWithModel", async () => {
  // Without modelFallback, a retryable failure is NOT retried (the orchestrator handles it).
  let createCalls = 0;
  const errorHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => { createCalls += 1; return { session: errorChild, model: "Ollama/glm-5.2:cloud" }; } };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 1, "no retry without modelFallback");
  strictEqual(out.isError, true);
  strictEqual((out.details as any).retriedWithModel, undefined, "no retriedWithModel when no fallback configured");
  ok(((out as any).content?.[0]?.text).includes("rate limited") || ((out as any).content?.[0]?.text).includes("stopReason"), `surfaces the error: ${(out as any).content?.[0]?.text}`);
});

test("#39 tail: defaultModelFallback (deps) retries when no per-dispatch modelFallback is passed", async () => {
  // The global default fallback (wired from ARMORY_FLEET_MODEL_FALLBACK in index.ts) lets a
  // retryable failure retry even without the per-dispatch `modelFallback` param. 1st create →
  // retryable fail; 2nd create (the retry on the default fallback) → success.
  let createCalls = 0;
  const errorHandlers: Array<(e: any) => void> = [];
  const okHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const okChild = {
    prompt: async () => { for (const h of okHandlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } }); },
    subscribe: (h: any) => { okHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = {
    create: async () => {
      createCalls += 1;
      return createCalls === 1 ? { session: errorChild, model: "Ollama/glm-5.2:cloud" } : { session: okChild, model: "Ollama/minimax-m3:cloud" };
    },
  };
  const deps = makeDeps();
  deps.defaultModelFallback = "Ollama/minimax-m3:cloud";   // global default, no per-dispatch param
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 2, "factory called twice (primary failed retryable → retried on the global default fallback)");
  strictEqual((out.details as any).status, "completed", `retry should succeed: ${(out as any).content?.[0]?.text}`);
  strictEqual((out.details as any).retriedWithModel, "Ollama/minimax-m3:cloud", "retriedWithModel marks the global fallback");
});

test("#39 tail: per-dispatch modelFallback takes precedence over defaultModelFallback", async () => {
  // When BOTH are set, the per-dispatch param wins (it's the more specific intent).
  let createCalls = 0;
  const okHandlers: Array<(e: any) => void> = [];
  const okChild = {
    prompt: async () => { for (const h of okHandlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered on per-dispatch" }] } }); },
    subscribe: (h: any) => { okHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const errorChild = {
    prompt: async () => { for (const h of okHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "x" }] } }); },
    subscribe: (h: any) => { okHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = {
    create: async () => {
      createCalls += 1;
      return createCalls === 1 ? { session: errorChild, model: "primary" } : { session: okChild, model: "Ollama/kimi-k3:cloud" };
    },
  };
  const deps = makeDeps();
  deps.defaultModelFallback = "Ollama/minimax-m3:cloud";   // should be OVERRIDDEN
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review", modelFallback: "Ollama/kimi-k3:cloud" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 2, "retried once");
  strictEqual((out.details as any).retriedWithModel, "Ollama/kimi-k3:cloud", "per-dispatch param wins over the global default");
});

test("#39 non-retryable failure (turn budget) + modelFallback: NO retry", async () => {
  // A turn-budget failure is not retryable — retrying on a fallback model wouldn't help. Assert no retry.
  let createCalls = 0;
  // fakeChild emits N turns; with maxTurns unset the tool default is 20, so pass maxTurns:2 + 3-turn child.
  const factory: ChildSessionFactory = {
    create: async () => {
      createCalls += 1;
      const handlers: Array<(e: any) => void> = [];
      return {
        session: {
          prompt: async () => { for (let i = 0; i < 3; i++) { for (const h of handlers) h({ type: "turn_end" }); for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "t" }] } }); } },
          subscribe: (h: any) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
        },
        model: "Ollama/glm-5.2:cloud",
      };
    },
  };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "loop", maxTurns: 2, modelFallback: "Ollama/minimax-m3:cloud" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 1, "turn-budget failure is NOT retried even with modelFallback");
  strictEqual(out.isError, true);
  strictEqual((out.details as any).retriedWithModel, undefined);
});

test("#39 modelFallback === primary model: NO retry (avoids retrying the same failing model)", async () => {
  // If the caller passes the same model as fallback, retrying would just hit the same rate-limit.
  let createCalls = 0;
  const errorHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => { createCalls += 1; return { session: errorChild, model: "Ollama/glm-5.2:cloud" }; } };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  // res.model is the tier-RESOLVED model (the factory's reported model is discarded). Pass an explicit
  // model override so res.model is deterministic, then modelFallback === that resolved model → no retry.
  const out = await tool.execute!("c", { agent: "g", task: "review", model: "Ollama/glm-5.2:cloud", modelFallback: "Ollama/glm-5.2:cloud" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 1, "no retry when modelFallback === the primary's resolved model");
  strictEqual((out.details as any).retriedWithModel, undefined);
});

// ── SPEC-6-5: cwd param + validation + cross-cwd notify ──

import { resolveDispatchCwd } from "../src/tools/subagent.ts";
import { homedir } from "node:os";

test("SPEC-6-5: resolveDispatchCwd returns undefined for absent cwd (default)", () => {
  const { cwd, error } = resolveDispatchCwd(undefined, "/session");
  strictEqual(cwd, undefined);
  strictEqual(error, undefined);
});

test("SPEC-6-5: resolveDispatchCwd returns undefined for empty string", () => {
  const { cwd, error } = resolveDispatchCwd("", "/session");
  strictEqual(cwd, undefined);
  strictEqual(error, undefined);
});

test("SPEC-6-5: resolveDispatchCwd rejects a nonexistent cwd", () => {
  const { cwd, error } = resolveDispatchCwd("/no/such/dir-xyz-12345", "/session");
  strictEqual(cwd, undefined);
  ok(error!.includes("cwd does not exist"), `error mentions 'does not exist': ${error}`);
});

test("SPEC-6-5: resolveDispatchCwd resolves a relative cwd against the parent", () => {
  // Use a real existing dir + a real existing relative subdir so the existence check passes.
  const repoRoot = process.cwd();
  const { cwd, error } = resolveDispatchCwd("src", repoRoot);
  strictEqual(error, undefined, `no error for existing relative subdir: ${error}`);
  ok(cwd!.endsWith("armory-fleet/src"), `resolved absolute against parent: ${cwd}`);
});

test("SPEC-6-5: tool rejects a nonexistent cwd", async () => {
  const deps = makeDeps();
  const tool = createSubagentTool(deps as any);
  const out = await tool.execute!("c", { agent: "g", task: "do", cwd: "/no/such/dir-xyz-12345" } as any, new AbortController().signal, () => {}, {} as any);
  ok(out.isError, "should be an error");
  ok((out.content[0] as any).text.includes("cwd does not exist"), `text mentions 'does not exist': ${(out.content[0] as any).text}`);
});

test("SPEC-6-5: cross-cwd dispatch fires onNotify", async () => {
  const notified: Array<{ message: string; kind?: string }> = [];
  const deps = makeDeps() as any;
  deps.onNotify = (message: string, kind?: string) => { notified.push({ message, kind }) };
  // Use the repo root (an existing dir ≠ "/tmp")
  const altCwd = process.cwd();
  if (altCwd === "/tmp") {
    // Edge case: if cwd IS /tmp, use homedir
  }
  const tool = createSubagentTool(deps as any);
  await tool.execute!("c", { agent: "g", task: "do", cwd: altCwd } as any, new AbortController().signal, () => {}, {} as any);
  ok(notified.length > 0, "onNotify fired for cross-cwd dispatch");
  ok(notified[0]!.message.includes("scoped to"), `notify message mentions 'scoped to': ${notified[0]!.message}`);
  ok(notified[0]!.message.includes(altCwd), `notify message includes the cwd: ${notified[0]!.message}`);
});

test("SPEC-6-5: same-cwd dispatch does NOT fire onNotify", async () => {
  const notified: Array<{ message: string; kind?: string }> = [];
  const deps = makeDeps() as any;
  deps.onNotify = (message: string, kind?: string) => { notified.push({ message, kind }) };
  const tool = createSubagentTool(deps as any);
  await tool.execute!("c", { agent: "g", task: "do" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(notified.length, 0, "onNotify NOT fired when cwd omitted (defaults to parentCwd)");
});

test("SPEC-6-5: subagentParams schema includes cwd", () => {
  ok("cwd" in subagentParams.properties, "cwd field in the schema");
});

test("#59: when the fallback retry also fails, the surfaced error includes the PRIMARY's failure", async () => {
  // Regression: the #39 retry returned only the FALLBACK's error — the primary's actual failure
  // (e.g. why an explicit model string failed at all) was masked entirely (#59 dogfood finding:
  // the surfaced error named 'openrouter/z-ai/glm-5.2' while the primary 'Ollama/glm-5.2:cloud'
  // failure was invisible).
  let createCalls = 0;
  const makeErrorChild = (text: string) => {
    const hs: Array<(e: any) => void> = [];
    return {
      prompt: async () => { for (const h of hs) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text }] } }); },
      subscribe: (h: any) => { hs.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
    };
  };
  const factory: ChildSessionFactory = {
    create: async () => {
      createCalls += 1;
      return createCalls === 1
        ? { session: makeErrorChild("primary rate limited"), model: "Ollama/glm-5.2:cloud" }
        : { session: makeErrorChild("fallback rate limited too"), model: "openrouter/z-ai/glm-5.2" };
    },
  };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x", model: "Ollama/glm-5.2:cloud", modelFallback: "openrouter/z-ai/glm-5.2" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(createCalls, 2, "factory called twice (primary failed retryable → retried on fallback)");
  strictEqual(out.isError, true, "both primary and fallback failed");
  const text = (out.content as any)[0].text as string;
  ok(text.includes("Ollama/glm-5.2:cloud"), `error names the PRIMARY model: ${text}`);
  ok(text.includes("primary rate limited"), `error includes the PRIMARY's failure text: ${text}`);
  ok(text.includes("openrouter/z-ai/glm-5.2"), `error names the FALLBACK model: ${text}`);
  ok(text.includes("fallback rate limited too"), `error includes the FALLBACK's failure text: ${text}`);
});

test("#58: retryable failure with NO fallback configured → surfaces the enable-retry hint", async () => {
  // A retryable (stopReason 'error') failure with neither modelFallback nor defaultModelFallback
  // means the auto-retry silently didn't fire (#58) — the operator must be told, at the moment
  // it matters, how to enable it.
  const errorHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "Ollama/glm-5.2:cloud" }) };
  const deps = makeDeps();   // no defaultModelFallback set
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(out.isError, true);
  const text = (out.content as any)[0].text as string;
  ok(text.includes("rate limited"), `keeps the original failure: ${text}`);
  ok(text.includes("no modelFallback configured"), `surfaces the no-fallback hint: ${text}`);
  ok(text.includes("ARMORY_FLEET_MODEL_FALLBACK"), `names the env var: ${text}`);
});

test("#58: per-dispatch modelFallback set → NO no-fallback hint (retry already handled it)", async () => {
  const errorHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "Ollama/glm-5.2:cloud" }) };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x", modelFallback: "openrouter/z-ai/glm-5.2" } as any, new AbortController().signal, () => {}, {} as any);
  const text = (out.content as any)[0].text as string;
  ok(!text.includes("no modelFallback configured"), `hint absent when a fallback was configured: ${text}`);
});

test("#58: global defaultModelFallback set → NO no-fallback hint", async () => {
  const errorHandlers: Array<(e: any) => void> = [];
  const errorChild = {
    prompt: async () => { for (const h of errorHandlers) h({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] } }); },
    subscribe: (h: any) => { errorHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "Ollama/glm-5.2:cloud" }) };
  const deps = makeDeps();
  deps.defaultModelFallback = "openrouter/z-ai/glm-5.2";
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x" } as any, new AbortController().signal, () => {}, {} as any);
  const text = (out.content as any)[0].text as string;
  ok(!text.includes("no modelFallback configured"), `hint absent when the global default is set: ${text}`);
});

test("#58: non-retryable failure (prompt threw) → NO hint regardless of fallback config", async () => {
  const hs: Array<(e: any) => void> = [];
  const crashChild = {
    prompt: async () => { for (const h of hs) h({ type: "turn_start", turnIndex: 0 }); throw new Error("child crashed mid-prompt"); },
    subscribe: (h: any) => { hs.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: crashChild, model: "Ollama/glm-5.2:cloud" }) };
  const deps = makeDeps();   // no fallback configured
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual(out.isError, true);
  const text = (out.content as any)[0].text as string;
  ok(text.includes("child crashed mid-prompt"), `surfaces the real failure: ${text}`);
  ok(!text.includes("no modelFallback configured"), `no hint on a non-retryable failure: ${text}`);
});

test("#61: zero-tool completed run → result prefixed with the premature-return warning", async () => {
  // The #61 dogfood failure: an implementer returned after one planning statement, zero tool
  // calls, looking like a normal (terse) completion. The tool must flag it, not just relay it.
  const deps = makeDeps();   // default fakeFactory child: one assistant message_end, no tools
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "implement a big feature" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual((out.details as any).status, "completed");
  strictEqual((out.details as any).toolCallCount, 0, "details expose the zero-tool count");
  const text = (out.content as any)[0].text as string;
  ok(text.includes("[FLEET] zero-tool-call run"), `warning prefix present: ${text.slice(0, 160)}`);
  ok(text.includes("premature return"), `names the failure mode: ${text.slice(0, 160)}`);
  ok(text.includes("done"), `original finalText preserved after the warning: ${text}`);
});

test("#61: completed run WITH tool calls → no warning prefix, accurate count", async () => {
  const handlers: Array<(e: any) => void> = [];
  const toolChild = {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start", turnIndex: 0 });
      for (const h of handlers) h({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false });
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      for (const h of handlers) h({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] });
    },
    subscribe: (h: any) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: toolChild, model: "m" }) };
  const deps = makeDeps();
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  deps.backendRegistry = reg;
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "x" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual((out.details as any).toolCallCount, 1);
  strictEqual((out.content as any)[0].text, "done", "no prefix on a run that did work");
});

// ── #62: the tool threads the resolved cwd into the bg + scheduled entry points ──

test("#62: background dispatch with cwd threads it to runBackground → runLifecycle entryCwd", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub62-"));
  const childCwd = mkdtempSync(join(tmpdir(), "sub62-child-"));
  let seenEntryCwd: string | undefined = "sentinel";
  const fakeAsyncRunner = {
    worktree: { isGitRepo: () => false, create: () => { throw new Error("no"); }, removeWorktree: () => {}, remove: () => {}, exists: () => false, branchFor: () => "fleet/x", pathFor: () => plain },
    diff: {}, journal: { append: () => {}, replay: () => [], scanNonTerminal: () => [] },
    pool: { withSlot: async (fn: () => Promise<void>) => { await fn(); } },
    inbox: { push: () => {}, readyCount: () => 0, pull: () => [], renderHint: () => "" },
    runLifecycle: async (_t: string, _l: string, opts: any) => {
      seenEntryCwd = opts.entryCwd;
      return { runId: opts.runId, status: "completed", phases: [{ name: "p", status: "completed", summary: "s", paths: [], reviseCount: 0 }], todoId: null } as any;
    },
    notify: () => {}, genRunId: () => "fl-62",
  } as any;
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", background: true, isolation: "none", cwd: childCwd } as any, new AbortController().signal, () => {}, {} as any);
  ok(!res.isError, `expected success, got: ${(res.content as any)[0]?.text}`);
  await new Promise((r) => setTimeout(r, 30));
  strictEqual(seenEntryCwd, childCwd, "tool must thread the resolved cwd into the bg run");
  rmSync(plain, { recursive: true, force: true });
  rmSync(childCwd, { recursive: true, force: true });
});

test("#62: scheduled dispatch with cwd stores it on the schedule", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub62-sched-"));
  const childCwd = mkdtempSync(join(tmpdir(), "sub62-sched-child-")); // must exist — resolveDispatchCwd validates
  let registered: any;
  const fakeScheduler = { register: (spec: any) => { registered = spec; return "sch-62"; }, list: () => [{ id: "sch-62", nextFire: null }] };
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, scheduler: fakeScheduler } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", schedule: "5m", cwd: childCwd } as any, new AbortController().signal, () => {}, {} as any);
  ok(!res.isError, `expected success, got: ${(res.content as any)[0]?.text}`);
  strictEqual(registered.cwd, childCwd, "scheduler.register receives the resolved (absolute) cwd");
  strictEqual(registered.cwd, resolve(childCwd), "cwd is the resolved absolute path");
  rmSync(plain, { recursive: true, force: true });
  rmSync(childCwd, { recursive: true, force: true });
});

// --- #88: language-drift flag (spec: docs/superpowers/specs/2026-09-02-spec-language-drift-flag.md) ---

test("#88: CJK-majority final report → warning prefix + details fields", async () => {
  const driftHandlers: Array<(e: any) => void> = [];
  const driftChild = {
    prompt: async () => {
      for (const h of driftHandlers) {
        h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "审查已完成。所有五个发现均已针对差异进行验证，代码质量良好，没有明显的问题需要修复，可以合并。" }] } });
      }
    },
    subscribe: (h: any) => { driftHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const deps = makeDeps();
  deps.backendRegistry = regWith({ create: async () => ({ session: driftChild, model: "zai/glm-5.3-flash" }) });
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review the diff" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual((out.details as any).status, "completed");
  strictEqual((out.details as any).languageDrift, true, "details expose the drift flag");
  ok(typeof (out.details as any).languageDriftRatio === "number", "details expose the ratio");
  const text = (out.content as any)[0].text as string;
  ok(text.includes("[FLEET] language drift"), `warning prefix present: ${text.slice(0, 120)}`);
  ok(text.includes("CJK-family"), `names the script family: ${text.slice(0, 160)}`);
  ok(text.includes("可以合并"), `original report preserved after the warning: ${text.slice(-60)}`);
});

test("#88: English report → no prefix, languageDrift undefined", async () => {
  const deps = makeDeps();   // default fakeFactory child reports "done"
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "hi" } as any, new AbortController().signal, () => {}, {} as any);
  strictEqual((out.details as any).languageDrift, undefined, "no drift flag on clean English");
  const text = (out.content as any)[0].text as string;
  ok(!text.includes("[FLEET] language drift"), `no prefix: ${text.slice(0, 80)}`);
});

test("#88: drifted run journals languageDrift on run:ended (post-hoc diagnosability)", async () => {
  const driftHandlers: Array<(e: any) => void> = [];
  const driftChild = {
    prompt: async () => {
      for (const h of driftHandlers) {
        h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "审查已完成。所有五个发现均已针对差异进行验证，代码质量良好，没有明显的问题需要修复，可以合并。" }] } });
      }
    },
    subscribe: (h: any) => { driftHandlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const deps = makeDeps();
  const log = new (await import("../src/runtime/run-log.ts")).RunLog(tmpDir);
  (deps as any).runLog = log;
  deps.backendRegistry = regWith({ create: async () => ({ session: driftChild, model: "zai/glm-5.3-flash" }) });
  const tool = createSubagentTool(deps);
  const out = await tool.execute!("c", { agent: "g", task: "review the diff" } as any, new AbortController().signal, () => {}, {} as any);
  const runId = (out.details as any).runId as string;
  const ended = log.replay(runId).find((e) => e.type === "run:ended") as any;
  ok(ended, "run:ended journaled");
  strictEqual(ended.languageDrift, true, "journal carries the drift flag");
  ok(typeof ended.languageDriftRatio === "number", "journal carries the ratio");
});
