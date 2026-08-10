// test/spawnSubagent.test.mts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodo } from "@getpipher/armory-todo";
import { spawnSubagent, type ChildSession, type ChildSessionEvent, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock, createForegroundLock } from "../src/engine/concurrency-lock.ts";
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
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, userMemory: false, backend: "pi", sessionKey: name, source: "builtin", filePath: "/x",
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

/** #49: a child that edits 2 files then hits the turn budget mid-task. The partial-result report
 *  must surface WHAT was modified (filesTouched) so the controller can re-inspect only those,
 *  not the whole repo. */
function budgetChildWithTools(toolEvents: Record<string, unknown>[], finalText: string, turns: number): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  let aborted = false;
  return {
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        for (const h of handlers) h({ type: "turn_end" });
        // emit the scripted tool events on the first turn only (realistic: tools fire mid-turn)
        if (i === 0) for (const te of toolEvents) for (const h of handlers) h({ type: "tool_execution_end", ...te } as unknown as ChildSessionEvent);
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; }, dispose: () => {},
  };
}

test("#49: turn-budget partial surfaces filesTouched (edit/write paths) on SpawnResult + in the error", async () => {
  const child = budgetChildWithTools([
    { toolName: "edit", args: { path: "src/migration.sql", edits: [] } },
    { toolName: "write", args: { path: "src/journal.log", content: "x" } },
    { toolName: "read", args: { path: "src/untouched.ts" } }, // read is NOT a mutation — excluded
  ], "partial mid-thought", 25);
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "migrate", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  // filesTouched carries the 2 mutation paths, deduped + sorted, read excluded
  ok(Array.isArray(res.filesTouched), "filesTouched is an array");
  deepStrictEqual(res.filesTouched, ["src/journal.log", "src/migration.sql"], `filesTouched = the 2 mutation paths: ${JSON.stringify(res.filesTouched)}`);
  // the error surfaces them too (the controller reads res.error)
  ok(res.error!.includes("Files modified before the cut:"), `error names files modified: ${res.error}`);
  ok(res.error!.includes("src/migration.sql"), `error lists migration.sql: ${res.error}`);
  ok(res.error!.includes("src/journal.log"), `error lists journal.log: ${res.error}`);
  ok(!res.error!.includes("src/untouched.ts"), `read path excluded from filesTouched: ${res.error}`);
});

test("#49: reachedSummary=false when the child is cut mid-tool-work (last event was a tool, no trailing assistant message)", async () => {
  // A child that runs 20 turns; the 20th (final) turn emits a tool but the budget aborts before
  // any trailing assistant message_end — reachedSummary=false (cut mid-work), not a summary.
  const handlers: Array<(e: any) => void> = [];
  let aborted = false;
  const child: ChildSession = {
    prompt: async () => {
      for (let i = 0; i < 20; i++) {
        if (aborted) break;
        for (const h of handlers) h({ type: "turn_end" });
        if (i === 19) {
          // final turn: emit a tool, NO trailing assistant message (cut mid-tool-work)
          for (const h of handlers) h({ type: "tool_execution_end", toolName: "edit", args: { path: "src/last.sql" } } as unknown as ChildSessionEvent);
        } else {
          for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step " + i }] } });
        }
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; }, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "migrate", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  strictEqual(res.reachedSummary, false, `reachedSummary=false when cut mid-tool-work: ${res.reachedSummary}`);
  ok(res.error!.includes("Reached summary: no"), `error states reachedSummary=no: ${res.error}`);
});

test("#49: reachedSummary=true when the child emitted a trailing assistant message after its last tool", async () => {
  // The normal turn-budget case: the child runs tools then emits a final assistant message
  // (its partial summary) before the budget aborts. reachedSummary=true signals the controller
  // that finalText is a summary, not a mid-thought.
  const child = budgetChildWithTools([
    { toolName: "edit", args: { path: "src/a.sql" } },
  ], "INCOMPLETE — renamed the SQL file but not the journal", 25);
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "migrate", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  strictEqual(res.reachedSummary, true, `reachedSummary=true with trailing assistant message: ${res.reachedSummary}`);
  ok(res.error!.includes("Reached summary: yes"), `error states reachedSummary=yes: ${res.error}`);
});

test("#49: completed run also surfaces filesTouched (no reachedSummary flag needed)", async () => {
  const child = budgetChildWithTools([
    { toolName: "edit", args: { path: "src/a.ts" } },
    { toolName: "write", args: { path: "README.md" } },
  ], "all done", 3);
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  deepStrictEqual(res.filesTouched, ["README.md", "src/a.ts"], `completed run filesTouched: ${JSON.stringify(res.filesTouched)}`);
});

test("#49: bash redirections + tee are extracted (best-effort); bare-word targets + reads excluded", async () => {
  // The bash branch of extractTouchedFiles captures `>`/`>>`/`tee` targets that look like a path
  // (contain `/` or `.`). Bare-word targets (no path separator) are skipped to avoid false
  // positives on `echo done` / `exit 0`. `read` tool events are never mutations.
  const child = budgetChildWithTools([
    { toolName: "bash", args: { command: "echo x > migrations/001.sql" } },
    { toolName: "bash", args: { command: "cat schema.log >> migrations/001.sql" } },
    { toolName: "bash", args: { command: "tee -a src/audit.txt < /dev/null" } },
    { toolName: "bash", args: { command: "echo done > log" } },            // bare word — excluded
    { toolName: "bash", args: { command: "pnpm test:run" } },             // no redirection — excluded
    { toolName: "read", args: { path: "src/untouched.ts" } },             // read — excluded
  ], "partial", 25);
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "migrate", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  deepStrictEqual(res.filesTouched, ["migrations/001.sql", "src/audit.txt"], `bash redirection targets + tee extracted; input files (cat schema.log), bare words, reads excluded: ${JSON.stringify(res.filesTouched)}`);
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
  const fgAcq = await fgLock.acquire("fl-fg");
  ok(fgAcq.ok, "foreground acquires its lock");
  const bgLock = createSingleSlotLock();    // the bg run's own fresh lock (per-run)
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "bg phase", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: bgLock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed", `bg spawn succeeds with its own lock even while foreground lock is held; got: ${res.error}`);
  fgLock.release("fl-fg");
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
  const fgAcq = await fgLock.acquire("fl-fg");
  ok(fgAcq.ok, "foreground write dispatch holds the lock");
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
  deepStrictEqual(fgLock.holders(), ["fl-fg"], "readOnly dispatch leaves the write lock held");
  fgLock.release("fl-fg");
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
  strictEqual(h.lock.holders().length, 0, "lock is free after a readOnly run");
  // A subsequent write dispatch can still acquire it.
  const nextAcq = await h.lock.acquire("fl-next");
  ok(nextAcq.ok, "write dispatch acquires after a readOnly run");
  h.lock.release("fl-next");
});

test("#31 two readOnly dispatches run in parallel (both enter prompt concurrently)", async () => {
  // Two read-only dispatches must both be able to proceed past the lock simultaneously. Each
  // child captures its own handler list and emits a message_end on release (so the run completes
  // cleanly — a subscribe that discards the handler would trip the EMPTY_RESULT guard). Both
  // children must ENTER prompt before either is released, proving neither was rejected by the
  // other's presence (the race that hung the first draft of this test).
  // Each child exposes a waitForEntered() promise that resolves when its prompt() is entered —
  // deterministic (no magic-number tick loop). Awaiting both via Promise.all proves they enter
  // concurrently; if either were rejected by the lock, this await would hang until the test timeout.
  const makeSlowChild = (): { session: ChildSession; waitForEntered: () => Promise<void>; release: () => void } => {
    const handlers: Array<(e: any) => void> = [];
    let releaseFn: () => void = () => {};
    let enteredResolve: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => { enteredResolve = r; });
    return {
      waitForEntered: () => enteredPromise,
      session: {
        prompt: () => { enteredResolve(); return new Promise<void>((res) => { releaseFn = res; }); },
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
  // Deterministic gate: both children must enter prompt before either is released. The Promise.all
  // resolves only once both prompt() calls have run — proving neither was rejected by the lock. If
  // either dispatch were serialized, this await would hang until the test timeout.
  await Promise.all([a.waitForEntered(), b.waitForEntered()]);
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

test("#31 tail: cap=3 lock — 3 write dispatches run in parallel, the 4th WAITS (not rejected)", async () => {
  // The #31 tail acceptance: a cap>1 ForegroundLock queues instead of rejecting. 4 write dispatches
  // on a cap=3 lock — 3 enter prompt concurrently, the 4th waits; releasing one lets the 4th in;
  // all complete. Uses the same entered-gate pattern as the readOnly-parallel test (deterministic).
  const makeSlowChild = (): { session: ChildSession; waitForEntered: () => Promise<void>; entered: () => boolean; release: () => void } => {
    const handlers: Array<(e: any) => void> = [];
    let releaseFn: () => void = () => {};
    let entered = false;
    let enteredResolve: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => { enteredResolve = r; });
    return {
      waitForEntered: () => enteredPromise,
      entered: () => entered,
      session: {
        prompt: () => { entered = true; enteredResolve(); return new Promise<void>((res) => { releaseFn = res; }); },
        subscribe: (h: (e: any) => void) => { handlers.push(h); return () => {}; },
        abort: async () => {}, dispose: () => {},
      },
      release: () => {
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
        releaseFn();
      },
    };
  };
  const kids = [makeSlowChild(), makeSlowChild(), makeSlowChild(), makeSlowChild()];
  let call = 0;
  const factory: ChildSessionFactory = {
    create: async () => { const k = kids[call]!; call += 1; return { session: k.session, model: "m" }; },
  };
  const h = harness(factory);
  const lock = createForegroundLock(3);   // cap=3 — the session-level concurrency setting
  const ps = kids.map((_, i) => spawnSubagent({
    agent: "g", task: `write ${i}`, track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  }));
  // 3 enter prompt concurrently; the 4th waits (not entered).
  await Promise.all([kids[0]!.waitForEntered(), kids[1]!.waitForEntered(), kids[2]!.waitForEntered()]);
  strictEqual(kids[3]!.entered(), false, "4th dispatch is queued (not entered) while 3 slots are held");
  strictEqual(lock.holders().length, 3, "3 slots held");
  // Release one → the 4th acquires its slot and enters.
  kids[0]!.release();
  await kids[3]!.waitForEntered();
  strictEqual(kids[3]!.entered(), true, "4th dispatch entered after a slot freed");
  // Drain: release the rest + await all 4.
  kids[1]!.release(); kids[2]!.release(); kids[3]!.release();
  const results = await Promise.all(ps);
  for (const r of results) strictEqual(r.status, "completed", `all 4 complete: ${r.error}`);
  strictEqual(lock.holders().length, 0, "all slots freed after drain");
});

test("#39 retryable: stopReason 'error' failure is marked retryable (for the tool's fallback retry)", async () => {
  // A provider rate-limit / auth failure (stopReason "error") must surface retryable:true so the
  // subagent tool can auto-retry on the fallback model. Non-retryable failures leave it unset.
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const errorChild: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "rate limited" }] },
      } as unknown as ChildSessionEvent);
    },
    subscribe: (h: (e: ChildSessionEvent) => void) => { handlers.push(h); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: errorChild, model: "Ollama/glm-5.2:cloud" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "review", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  strictEqual(res.retryable, true, "stopReason 'error' (rate-limit/auth) is retryable");
});

test("#39 retryable: turn-budget exhaustion is NOT retryable (not a provider failure)", async () => {
  // A turn-budget failure is a task-complexity issue, not a provider rate-limit — retrying on a
  // fallback model wouldn't help. retryable must be unset.
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(25, "partial"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "loop", track: false, maxTurns: 20,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "failed");
  ok(!res.retryable, "turn-budget failure is not retryable");
});

test("#23 abort clarification: aborted run names TODO reversion + filesystem-not-rolled-back", async () => {
  // Trigger abort via the AbortSignal (the onSignalAbort path sets aborted=true + session.abort()).
  // Assert the surfaced error distinguishes TODO-status reversion from filesystem rollback.
  const ac = new AbortController();
  let releasePrompt: () => void = () => {};
  const slowChild: ChildSession = {
    prompt: () => new Promise<void>((res) => { releasePrompt = res; }),
    subscribe: () => () => {}, abort: async () => { releasePrompt(); }, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: slowChild, model: "m" }) };
  const h = harness(factory);
  const p = spawnSubagent({
    agent: "g", task: "long work", track: false, signal: ac.signal,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  await new Promise((r) => setImmediate(r)); // let the subscribe listener attach
  ac.abort();
  const res = await p;
  strictEqual(res.status, "aborted");
  ok(res.error!.includes("TODO reverted to open"), `error names TODO reversion: ${res.error}`);
  ok(res.error!.includes("NOT rolled back"), `error names filesystem-not-rolled-back: ${res.error}`);
});

test("#23 liveness: turnCount + lastEventClass written to the RunRecord on events", async () => {
  // A child that emits a turn_start + a tool_execution_end + an assistant message_end. After the run,
  // the RunRecord should carry turnCount (1-indexed) + lastEventClass (the last meaningful event).
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const child: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start" });
      for (const h of handlers) h({ type: "tool_execution_end", toolName: "edit" } as unknown as ChildSessionEvent);
      for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  const rec = h.runRegistry.get(res.runId);
  ok(rec, "run record exists");
  strictEqual(rec!.turnMax, 1000, "turnMax set at spawn (engine DEFAULT_MAX_TURNS)");
  strictEqual(rec!.turnCount, 1, "turnCount is 1 after one turn_start (1-indexed)");
  // lastEventClass is the last meaningful event — message_end (assistant) after tool_execution_end.
  // The update fires on turn_start, tool_execution_end, message_end — the last is "assistant".
  strictEqual(rec!.lastEventClass, "assistant", `lastEventClass = assistant (last meaningful event): ${rec!.lastEventClass}`);
  ok(typeof rec!.lastEventAt === "number", "lastEventAt timestamp set");
});

test("#32 substrate baseline: captured at end of turn 1 (first assistant message_end) and threaded to RunRecord", async () => {
  // A child that completes turn 1 with a real usage block (substrate-dominated context).
  // The RunRecord should carry substrateBaseline == contextTokens from that first turn.
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const child: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start" }); // turnIdx -1 → 0 (turn 1)
      for (const h of handlers) h({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "turn 1 done" }],
          usage: { input: 570_000, output: 48, cacheRead: 0, cacheWrite: 5_000, cost: { total: 0.001 } },
        },
      });
    },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  strictEqual(res.status, "completed");
  const rec = h.runRegistry.get(res.runId);
  ok(rec, "run record exists");
  // contextTokens at turn 1 = input + output + cacheRead + cacheWrite = 575,048.
  strictEqual(rec!.contextTokens, 575_048, `contextTokens = turn-1 calcContextTokens: ${rec!.contextTokens}`);
  strictEqual(rec!.substrateBaseline, 575_048, `substrateBaseline captured == turn-1 contextTokens: ${rec!.substrateBaseline}`);
});

test("#32 substrate baseline: NOT captured when turn 1 produces no assistant message_end", async () => {
  // Defensive: a child that aborts before emitting any assistant message_end must not set a
  // baseline (there's no turn-1 context to anchor the substrate comparison against).
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const child: ChildSession = {
    prompt: async () => {
      for (const h of handlers) h({ type: "turn_start" });
      // No message_end — simulates a silent abort / empty result. prompt() just resolves.
    },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: child, model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, backendRegistry: regWith(h.factory),
    parentModel: PARENT, parentCwd: "/tmp",
  });
  // No assistant message_end → #22 EMPTY_RESULT failure.
  strictEqual(res.status, "failed");
  const rec = h.runRegistry.get(res.runId);
  ok(rec, "run record exists");
  ok(rec!.substrateBaseline === undefined, `no assistant message_end → no substrateBaseline: ${rec!.substrateBaseline}`);
});
