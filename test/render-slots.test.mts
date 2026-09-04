// test/render-slots.test.mts — pure timer-decision state machine for the #104 render slots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRenderState, type RenderSlotState } from "../src/transcript/render-state.ts";
import type { RunCardState } from "../src/transcript/card-state.ts";

const idle: RenderSlotState = { frame: 0, timer: null, lastCard: null };
const animating: RenderSlotState = { frame: 3, timer: {} as NodeJS.Timeout, lastCard: null };
const withCard: RenderSlotState = {
  frame: 5, timer: {} as NodeJS.Timeout,
  lastCard: { runId: "fl-x", agent: "a", model: "m", task: "t", status: "running", startedAt: 0 },
};

test("render slots: still dispatching (no card, partial window) starts the animation timer once", () => {
  const d = nextRenderState(idle, { hasCard: false, isPartial: true });
  assert.deepEqual(d, { startTimer: true, stopTimer: false });
});

test("render slots: timer already running and still no card — no double start", () => {
  const d = nextRenderState(animating, { hasCard: false, isPartial: true });
  assert.deepEqual(d, { startTimer: false, stopTimer: false });
});

test("render slots: the first partial card stops the timer (events drive updates from here)", () => {
  assert.deepEqual(nextRenderState(animating, { hasCard: true, isPartial: true }), { startTimer: false, stopTimer: true });
  assert.deepEqual(nextRenderState(withCard, { hasCard: true, isPartial: true }), { startTimer: false, stopTimer: true });
});

test("render slots: final render always stops any surviving timer; idle final is a no-op", () => {
  assert.deepEqual(nextRenderState(animating, { hasCard: false, isPartial: false }), { startTimer: false, stopTimer: true });
  assert.deepEqual(nextRenderState(withCard, { hasCard: false, isPartial: false }), { startTimer: false, stopTimer: true });
  assert.deepEqual(nextRenderState(idle, { hasCard: false, isPartial: false }), { startTimer: false, stopTimer: false });
});

test("renderCall and renderResult partials share one frame geometry (#108)", async () => {
  const { createSubagentTool } = await import("../src/tools/subagent.ts");
  const tool = createSubagentTool({
    parentCwd: "/tmp", parentModel: { provider: "x", id: "y" },
  } as never);
  const ctx = { state: { frame: 0, timer: null, lastCard: null as RunCardState | null } };
  const theme = { fg: (_t: string, s: string) => s };
  // While dispatching (no card yet): renderCall builds a provisional card.
  const call = tool.renderCall({ agent: "reviewer", task: "Review PR" }, theme as never, ctx as never);
  const callLines = (call as { render(w: number): string[] }).render(200);
  // After a card arrives: renderResult partial uses the same builder.
  ctx.state.lastCard = {
    runId: "fl-1", agent: "reviewer", model: "glm", task: "Review PR",
    status: "running", startedAt: 0,
  };
  const partial = tool.renderResult({ content: [], details: { card: ctx.state.lastCard } }, { isPartial: true, expanded: false }, theme as never, ctx as never);
  const partialLines = (partial as { render(w: number): string[] }).render(200);
  const widths = (ls: string[]) => [...new Set(ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/╭|╮|╰|╯|│/g, "").length + 2))];
  for (const ls of [callLines, partialLines]) {
    assert.equal(ls.length, 4);
    assert.ok(new Set(widths(ls)).size === 1, `uniform width, got ${widths(ls)}`);
  }
  assert.equal(widths(callLines)[0], widths(partialLines)[0]);
});
