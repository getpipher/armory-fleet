// test/spawnSubagent.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodo } from "@getpipher/armory-todo";
import { spawnSubagent, type ChildSession, type ChildSessionEvent, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
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
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-engine-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
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

test("completes + creates a fleet task + marks done", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(3, "all done"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
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
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("turn budget"), res.error);
  strictEqual(getTodo(res.todoId!).status, "open");
});

test("#25: turn-budget partial is surfaced coherently, not sliced mid-sentence at 200 chars", async () => {
  // The pre-#25 fix sliced finalText to 200 chars in the error, cutting mid-thought (e.g.
  // "...except the G48 viola"). The controller reads res.error (the tool surfaces error, not
  // finalText, for failed runs), so the partial must be coherent. With the fix, a >4000-char
  // partial is windowed to 4000 chars with a truncation marker; a <4000-char partial is whole.
  const longPartial = "INCOMPLETE — maxTurns hit.\nCompleted checks: a, b, c\nNot reached: d, e\nFindings so far: " + "x".repeat(5000);
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(25, longPartial), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "review", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("turn budget"), res.error);
  // The structured partial header survives (not cut at 200 chars)
  ok(res.error!.includes("INCOMPLETE — maxTurns hit."), `structured header should survive: ${res.error!.slice(0, 120)}`);
  ok(res.error!.includes("Completed checks: a, b, c"), `completed checks should survive: ${res.error!.slice(0, 120)}`);
  // A >4000-char partial is windowed with a truncation marker, not sliced mid-sentence silently
  ok(res.error!.includes("(partial truncated"), `truncation marker should be present for >4000-char partial`);
  // The 200-char slice would have cut at "Findings so far: xxx..." — assert we got well past 200
  ok(res.error!.length > 200, `error should be far longer than the old 200-char slice: ${res.error!.length}`);
});

test("#25: short turn-budget partial is surfaced whole (no truncation marker)", async () => {
  const shortPartial = "INCOMPLETE — maxTurns hit.\nCompleted checks: a, b\nFindings: none yet";
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(25, shortPartial), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "review", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes(shortPartial), `short partial should be surfaced whole: ${res.error}`);
  ok(!res.error!.includes("(partial truncated"), `no truncation marker for short partial`);
});

test("#22: prompt() resolving with NO assistant message_end -> EMPTY_RESULT failed, not silent completed", async () => {
  // A child whose prompt() resolves without ever emitting an assistant message_end (a silent
  // backend failure, hung provider, or premature exit). Pre-#22 this fell through to `completed`
  // with empty finalText — the controller saw "(no tool output)" with no status/run id. With the
  // EMPTY_RESULT guard it's a structured failure the controller can escalate.
  const silentChild: ChildSession = {
    prompt: async () => { /* resolves with no events */ },
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: silentChild, model: "p/m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed", "no assistant output must be failed, not completed");
  ok(res.error!.includes("EMPTY_RESULT"), `should be a structured EMPTY_RESULT: ${res.error}`);
  ok(res.error!.includes("p/m"), `diagnostic should name the model: ${res.error}`);
  ok(!res.finalText, "no finalText should be recorded");
});

test("unknown agent -> failed with actionable message listing available", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "x"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "nope", task: "x", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("not in registry"), res.error);
  ok(res.error!.includes("available:"), res.error);
});

test("#26: model-call stopReason 'error' (401/provider down) -> failed with surfaced error, not empty completed", async () => {
  // A child whose model call ends with stopReason "error" (e.g. a stale explicit-model override
  // whose provider 401s, a provider outage, or a rate limit after retries are exhausted). The SDK
  // emits message_end with stopReason "error" and prompt() resolves WITHOUT throwing — so without
  // the #26 fix the run fell through to `completed` with empty finalText ("(no tool output)").
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const errorChild: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "Authentication failed for \"openrouter\"" }],
        },
      } as unknown as ChildSessionEvent);
    },
    subscribe: (h: (e: ChildSessionEvent) => void) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "openrouter/z-ai/glm-5.2" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "review the spec", track: true, model: "openrouter/z-ai/glm-5.2",
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed", "stopReason 'error' must be failed, not completed");
  ok(res.error!.includes("Authentication failed"), `error should surface the model failure text: ${res.error}`);
  ok(!res.finalText, "no finalText should be recorded for an error stop");
});

test("#26: stopReason 'error' with no content text -> failed with a structured diagnostic naming the model", async () => {
  // When the SDK surfaces stopReason "error" with empty content, the fix synthesizes a diagnostic
  // that names the model so the controller can act (escalate or re-dispatch) instead of seeing
  // an empty success.
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const errorChild: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "" }] },
      } as unknown as ChildSessionEvent);
    },
    subscribe: (h: (e: ChildSessionEvent) => void) => { handlers.push(h); return () => {}; },
    abort: async () => {},
    dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "Ollama/minimax-m3:cloud" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "x", track: false, model: "Ollama/minimax-m3:cloud",
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("stopReason 'error'"), `synthesized diagnostic should name the stop reason: ${res.error}`);
  ok(res.error!.includes("Ollama/minimax-m3:cloud"), `diagnostic should name the model: ${res.error}`);
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
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  const res2 = await spawnSubagent({
    agent: "g", task: "second", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res2.status, "failed");
  ok(res2.error!.includes("already running"), res2.error);
  ok(/fl-/.test(res2.error!), "names the running runId");
  await enteredPrompt; // p1 has reached session.prompt -> releasePrompt is now the real resolver
  releasePrompt();
  await p1;
});

test("SPEC-5a §8.1 (Q4=A): a fresh per-bg-run lock does NOT contend with the foreground lock", async () => {
  // Regression: the bg adapter used to pass `lock: deps.lock` (the foreground single-slot) to
  // bg-run spawns. When a foreground subagent held deps.lock, every bg run's first-phase spawn
  // failed fast (tryAcquire → "concurrency lock unexpectedly unavailable" → 6ms run:aborted).
  // Fix: each bg run gets its own fresh lock. This test proves the decoupling — hold the
  // foreground lock, then spawn with a SEPARATE fresh lock, assert it succeeds.
  const fgLock = createSingleSlotLock();   // the foreground single-slot (shared)
  ok(fgLock.tryAcquire("fl-fg"), "foreground acquires its lock");
  const bgLock = createSingleSlotLock();    // the bg run's own fresh lock (per-run)
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "bg phase", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: bgLock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed", `bg spawn succeeds with its own lock even while foreground lock is held; got: ${res.error}`);
  fgLock.release();
});

test("track:false touches no todo", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.todoId, null);
  strictEqual(res.status, "completed");
});

test("todo exclusion moved to the factory (spawnSubagent passes tools through unfiltered)", async () => {
  let captured: any;
  const factory: ChildSessionFactory = {
    create: async (opts) => { captured = opts; return { session: fakeChild(1, "ok"), model: "m" }; },
  };
  const a = agent("g"); a.tools = ["read", "bash", "todo", "edit"];
  const h = harness(factory, a);
  await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  // SPEC-2: spawnSubagent no longer filters — the child factory applies `excludeTools: ["todo"]` downstream.
  ok(captured.tools.includes("todo"), "todo passes through unfiltered (factory excludes it via excludeTools)");
  ok(captured.tools.includes("read"), "read kept");
});


test("#31 readOnly dispatch succeeds while a write dispatch holds the lock", async () => {
  // A read-only dispatch (review/audit) bypasses the foreground single-slot lock, so it can run
  // even while a write dispatch holds it. Hold the shared lock externally, then spawn readOnly.
  const fgLock = createSingleSlotLock();
  ok(fgLock.tryAcquire("fl-fg"), "foreground write dispatch holds the lock");
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "reviewed"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "review code", track: false, readOnly: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: fgLock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed", `readOnly spawn should bypass the held lock; got: ${res.error}`);
  strictEqual(res.finalText, "reviewed");
  // The readOnly dispatch must NOT have released the write dispatch's lock.
  strictEqual(fgLock.current(), "fl-fg", "readOnly dispatch leaves the write lock held");
  fgLock.release();
});

test("#31 readOnly dispatch does not acquire or release the lock", async () => {
  // After a readOnly run completes, the lock must still be free (a subsequent write dispatch
  // can acquire it). Regression guard: a readOnly that erroneously released would corrupt
  // serialization for a later write dispatch.
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "audit", track: false, readOnly: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  strictEqual(h.lock.current(), null, "lock is free after a readOnly run");
  // A subsequent write dispatch can still acquire it.
  ok(h.lock.tryAcquire("fl-next"), "write dispatch acquires after a readOnly run");
  h.lock.release();
});

test("#31 two readOnly dispatches run in parallel (both enter prompt concurrently)", async () => {
  // Two read-only dispatches must both be able to proceed past the lock simultaneously. Each
  // child captures its own handler list and emits a message_end on release (so the run completes
  // cleanly — a subscribe that discards the handler would trip the EMPTY_RESULT guard). Both
  // children must ENTER prompt before either is released, proving neither was rejected by the
  // other's presence (the race that hung the first draft of this test).
  const makeSlowChild = (): { session: ChildSession; entered: () => boolean; release: () => void } => {
    const handlers: Array<(e: any) => void> = [];
    let entered = false;
    let releaseFn: () => void = () => {};
    return {
      entered: () => entered,
      session: {
        prompt: () => { entered = true; return new Promise<void>((res) => { releaseFn = res; }); },
        subscribe: (h: (e: any) => void) => { handlers.push(h); return () => {}; },
        abort: async () => {}, dispose: () => {},
      },
      release: () => {
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
        releaseFn();
      },
    };
  };
  const a = makeSlowChild();
  const b = makeSlowChild();
  let call = 0;
  const factory: ChildSessionFactory = {
    create: async () => { call += 1; return { session: call === 1 ? a.session : b.session, model: "m" }; },
  };
  const h = harness(factory);
  const pA = spawnSubagent({
    agent: "g", task: "review a", track: false, readOnly: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  const pB = spawnSubagent({
    agent: "g", task: "review b", track: false, readOnly: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  // Yield so both can run until they block on their prompt promises. Use a microtask+macrotask
  // flush: a few setImmediate ticks let both advance through their await chain to prompt.
  for (let i = 0; i < 6; i++) { await new Promise((r) => setImmediate(r)); }
  ok(a.entered(), "readOnly A entered prompt (not blocked by concurrency lock)");
  ok(b.entered(), "readOnly B entered prompt concurrently (both bypass the lock)");
  a.release(); b.release();
  const [rA, rB] = await Promise.all([pA, pB]);
  strictEqual(rA.status, "completed", `A: ${rA.error}`);
  strictEqual(rB.status, "completed", `B: ${rB.error}`);
});

test("#31 write dispatch (readOnly unset) still serializes via the lock", async () => {
  // Regression guard: the default path (readOnly unset/false) must still reject a 2nd concurrent
  // write dispatch. Mirrors the existing "concurrency=1" test's entered-gate pattern: wait for p1
  // to ENTER prompt before issuing/relasing — without the gate, releasePrompt fires a no-op and
  // p1 blocks forever (the hang that the first draft of this test hit).
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
    agent: "g", task: "write", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  // Wait until p1 has entered prompt (releasePrompt is now the real resolver) before issuing res2.
  await enteredPrompt;
  const res2 = await spawnSubagent({
    agent: "g", task: "second-write", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res2.status, "failed");
  ok(res2.error!.includes("already running"), res2.error);
  ok(/fl-/.test(res2.error!), "names the running runId");
  releasePrompt();
  await p1;
});
