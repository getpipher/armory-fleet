// test/render-slots.test.mts — pure timer-decision state machine for the #104 render slots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRenderState, type RenderSlotState } from "../src/transcript/render-state.ts";

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
