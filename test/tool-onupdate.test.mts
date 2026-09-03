// test/tool-onupdate.test.mts
import { test, beforeEach, afterEach } from "node:test";
import assert, { ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardSnapshot } from "../src/transcript/card-state.ts";

const run = {
  runId: "fl-x", agent: "reviewer", model: "glm", task: "t", track: true, todoId: null,
  status: "running", startedAt: 1000, cwd: "/c", backend: "pi",
  turnCount: 3, lastEventClass: "tool:read", contextTokens: 1000, costTotal: 0.5,
} as never;

test("cardSnapshot maps RunRecord → RunCardState", () => {
  const s = cardSnapshot(run);
  assert.equal(s.runId, "fl-x");
  assert.equal(s.status, "running");
  assert.equal(s.turnCount, 3);
  assert.equal(s.lastEventClass, "tool:read");
});

test("cardSnapshot merges overrides (final status, warnings)", () => {
  const s = cardSnapshot(run, { status: "failed", error: "boom", warnings: ["zero-tool"] });
  assert.equal(s.status, "failed");
  assert.equal(s.error, "boom");
  assert.deepEqual(s.warnings, ["zero-tool"]);
});

// ── #104 regression tests: the onUpdate emission path (never-break + live TDZ) ──

import { createSubagentTool } from "../src/tools/subagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const CARD_AGENT: AgentDef = { name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, userMemory: false, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x" };

/** Factory whose session fires `midFlightEvents` during prompt, then a final assistant message_end. */
function cardFactory(midFlightEvents: Array<{ type: string; message?: { role?: string; content?: { type: string; text?: string }[] } }>): ChildSessionFactory {
  return {
    create: async () => {
      const handlers: Array<(e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[] } }) => void> = [];
      return {
        session: {
          prompt: async () => {
            for (const e of midFlightEvents) for (const h of handlers) h(e);
            for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
          },
          subscribe: (h: (e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[] } }) => void) => { handlers.push(h); return () => {}; },
          abort: async () => {},
          dispose: () => {},
        },
        model: "m",
      };
    },
  };
}
function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

let cardTmp: string;
beforeEach(() => { cardTmp = mkdtempSync(join(tmpdir(), "card-")); process.env.TODO_DIR = cardTmp; });
afterEach(() => { rmSync(cardTmp, { recursive: true, force: true }); delete process.env.TODO_DIR; });

test("#104 never-break: throwing onUpdate + registry whose .list() throws — run still completes", async () => {
  // Real registry (engine calls .add before anything) with ONLY .list() poisoned — exercises the
  // in-flight live-lookup guard, which is the part that crashed execute during development.
  const runRegistry = Object.assign(new RunRegistry(), { list: () => { throw new Error("boom"); } });
  const cards: unknown[] = [];
  const deps = {
    registry: new Map([["g", CARD_AGENT]]),
    runRegistry,
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    backendRegistry: regWith(cardFactory([{ type: "turn_start" }])),
    parentModel: { provider: "p", id: "m" },
    parentCwd: cardTmp,
    defaultModelFallback: undefined,
  };
  const tool = createSubagentTool(deps as any);
  const res = await tool.execute("tc1", { agent: "g", task: "t" } as never, undefined as never, (p: unknown) => { cards.push(p); if (cards.length > 99) throw new Error("throwing onUpdate"); }, {});
  ok(res, "execute returned a result");
  ok(!res.isError, `not an error: ${JSON.stringify(res).slice(0, 200)}`);
});

test("#104 live path: cards stream DURING the run (TDZ regression — hoisted res)", async () => {
  const runRegistry = new RunRegistry();
  const cards: Array<{ content: unknown[]; details: { card: { runId: string; status: string } } }> = [];
  const deps = {
    registry: new Map([["g", CARD_AGENT]]),
    runRegistry,
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    backendRegistry: regWith(cardFactory([
      { type: "turn_start" },
      { type: "tool_execution_end" },
    ])),
    parentModel: { provider: "p", id: "m" },
    parentCwd: cardTmp,
    defaultModelFallback: undefined,
  };
  const tool = createSubagentTool(deps as any);
  const res = await tool.execute("tc2", { agent: "g", task: "t" } as never, undefined as never, (p: unknown) => { cards.push(p as { content: unknown[]; details: { card: { runId: string; status: string } } }); }, {});
  ok(!res.isError, `not an error: ${JSON.stringify(res).slice(0, 200)}`);
  // The mid-flight turn_start fires BEFORE spawnSubagent's run record exists? No: the engine adds
  // the record + subscribes BEFORE prompt, so at turn_start the registry already has the RUNNING
  // record and the live lookup must find it — this assertion is the TDZ regression gate.
  ok(cards.length >= 1, `at least one live card, got ${cards.length}`);
  // The partial MUST carry pi's result envelope (content array + details) — the real TUI reads
  // result.content unconditionally in updateDisplay; a bare { card } crashed pi for real (#104 smoke).
  const first = cards[0] as { content: unknown[]; details: { card: { runId: string } } };
  ok(Array.isArray(first.content), "partial carries a content array");
  ok(first.details.card.runId.startsWith("fl-"), `card carries a real runId: ${first.details.card.runId}`);
});
