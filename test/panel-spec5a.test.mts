// test/panel-spec5a.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBgRow, bgStatusIcon, scheduleRow, type BgRunStatus } from "../src/panel/rows.ts";

test("bgStatusIcon maps statuses to icons", () => {
  assert.equal(bgStatusIcon("running"), "▶");
  assert.equal(bgStatusIcon("paused"), "⏸");
  assert.equal(bgStatusIcon("completed"), "✓");
  assert.equal(bgStatusIcon("failed"), "✗");
  assert.equal(bgStatusIcon("queued"), "⏳");
});

test("renderBgRow includes icon + phase progress for a running lifecycle", () => {
  const row: BgRunStatus = {
    runId: "fl-x", lifecycle: "default", status: "running", phase: "implement", phaseIndex: 3, phaseTotal: 5, mode: "checkpointed", backend: "pi", task: "add hello",
  };
  const line = renderBgRow(row);
  assert.match(line, /▶/);
  assert.match(line, /●implement 3\/5/);
  assert.match(line, /fl-x/);
});

test("renderBgRow shows ✓ + branch for a completed run", () => {
  const row: BgRunStatus = { runId: "fl-y", lifecycle: "default", status: "completed", phase: "finish", phaseIndex: 5, phaseTotal: 5, mode: "checkpointed", backend: "pi", task: "t", branch: "fleet/fl-y" };
  const line = renderBgRow(row);
  assert.match(line, /✓/);
  assert.match(line, /fleet\/fl-y/);
});

test("renderBgRow shows ⏳ for a queued run with 0/total progress", () => {
  const row: BgRunStatus = { runId: "fl-z", lifecycle: "default", status: "queued", phase: "", phaseIndex: 0, phaseTotal: 5, mode: "auto", backend: "pi", task: "t" };
  const line = renderBgRow(row);
  assert.match(line, /⏳/);
  assert.match(line, /0\/5/);
});

test("scheduleRow renders expression + next-fire + id", () => {
  const line = scheduleRow({ id: "sch-abc", expression: "30m", lifecycle: "default", task: "refresh cache", nextFire: new Date("2026-07-25T10:00:00Z"), paused: false });
  assert.match(line, /▶/);
  assert.match(line, /30m/);
  assert.match(line, /sch-abc/);
});

test("scheduleRow renders ⏸ + 'paused' for a paused schedule", () => {
  const line = scheduleRow({ id: "sch-p", expression: "2h", lifecycle: "default", task: "x", nextFire: null, paused: true });
  assert.match(line, /⏸/);
  assert.match(line, /paused/);
});