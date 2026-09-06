// test/preview-line.test.mts — P3 Fleet-tab live run-card preview row (#104).
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewLine } from "../src/panel/present.ts";
import { bgCardSnapshot } from "../src/panel/rows.ts";
import type { RunRecord } from "../src/engine/run-registry.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const rec = (over: Partial<RunRecord>): RunRecord =>
  ({ runId: "fl-x", agent: "reviewer", model: "glm", task: "Review PR", track: true, todoId: null,
     status: "running", startedAt: 0, turnCount: 3, lastEventClass: "tool:read",
     contextTokens: 186_000, maxContext: 1_000_000, ...over } as never);

const bg = (over: Partial<BgRunStatus>): BgRunStatus =>
  ({ runId: "bg-1", lifecycle: "guardian", status: "running", phase: "p", phaseIndex: 0, phaseTotal: 3,
     mode: "auto", backend: "glm", task: "watch", elapsedMs: 41_000, ...over });

test("previewLine: registry run, running → state line; else blank", () => {
  const src = { registry: { get: (id: string) => (id === "fl-x" ? rec({}) : undefined) } };
  const line = previewLine("fl-x", src, 41_000, 0);
  assert.ok(line.includes("●tool:read") && line.includes("turn 3") && line.includes("19%"));
  assert.equal(previewLine("fl-x", { registry: { get: () => rec({ status: "completed" as never }) } }, 41_000, 0), "");
});

test("previewLine: bg run, running → state line; else blank", () => {
  const src = { bgRuns: { values: () => [bg({})] as never } };
  const line = previewLine("bg-1", src, 60_000, 0);
  // startedAt = nowMs − elapsedMs = 19s; rendered elapsed = now − startedAt = 41s (the run ran 41s)
  assert.ok(line.includes("41s"), `elapsed from elapsedMs: ${line}`);
  assert.equal(previewLine("bg-1", { bgRuns: { values: () => [bg({ status: "failed" as never })] as never } }, 60_000, 0), "");
});

test("previewLine: no selection, stale id, missing stores → blank (defensive, never throws)", () => {
  assert.equal(previewLine(null, {}, 0, 0), "");
  assert.equal(previewLine(undefined, {}, 0, 0), "");
  assert.equal(previewLine("gone", { registry: { get: () => undefined }, bgRuns: { values: () => [] as never } }, 0, 0), "");
  assert.equal(previewLine("fl-x", {}, 0, 0), "");
});

test("previewLine: unthemed — no ANSI escapes (mirrors transcript literally)", () => {
  const line = previewLine("fl-x", { registry: { get: () => rec({}) } }, 41_000, 0);
  assert.ok(!line.includes("\x1b"), "no ANSI in preview");
});

test("bgCardSnapshot: maps lifecycle→agent, backend→model, elapsedMs→startedAt; null elapsed → nowMs", () => {
  const c = bgCardSnapshot(bg({}), 100_000);
  assert.equal(c.runId, "bg-1");
  assert.equal(c.agent, "guardian");
  assert.equal(c.model, "glm");
  assert.equal(c.startedAt, 59_000);
  assert.equal(bgCardSnapshot(bg({ elapsedMs: undefined }), 100_000).startedAt, 100_000);
});
