// test/runs-rows.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsRow, runTimelineRow } from "../src/panel/runs-rows.ts";
import type { RunMeta } from "../src/runtime/run-log.ts";

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  runId: "fl-1", agent: "g", model: "m", task: "do the thing", track: true, todoId: null,
  startedAt: 1000, status: "completed", endedAt: 1032000, resultSummary: "all done",
  tokenTotal: 142, ...over,
});

test("runsRow renders glyph + id + agent + duration + tokens + summary", () => {
  const line = runsRow(meta());
  assert.match(line, /^✓ fl-1/);
  assert.match(line, /g/);
  assert.match(line, /17m/); // 1032000-1000 = 1032000ms = 1032s = 17m12s → fmtDuration "17m12s"
  assert.match(line, /142 tok/);
  assert.match(line, /all done/);
});

test("runsRow renders ▶ for running, ✗ for failed/aborted", () => {
  assert.match(runsRow(meta({ status: "running", endedAt: undefined })), /^▶/);
  assert.match(runsRow(meta({ status: "failed" })), /^✗/);
  assert.match(runsRow(meta({ status: "aborted" })), /^✗/);
});

test("runsRow appends provenance arrow for resumed/forked", () => {
  assert.match(runsRow(meta({ resumedFrom: "fl-prior" })), /← resumed:fl-prior/);
  assert.match(runsRow(meta({ forkedFrom: "fl-other" })), /← forked:fl-other/);
});

test("runTimelineRow renders [a] + excerpt + tokens for assistant messages", () => {
  const line = runTimelineRow({ type: "message", role: "assistant", text: "I'll read the file first.", usage: { total: 142 }, turnIndex: 0 });
  assert.match(line, /\[a\]/);
  assert.match(line, /I'll read the file first/);
  assert.match(line, /142 tok/);
});

test("runTimelineRow renders [t] + name + path/args + glyph for tool calls", () => {
  const ok = runTimelineRow({ type: "tool", toolName: "read", args: "src/index.ts", result: "...", isError: false, turnIndex: 0 });
  assert.match(ok, /\[t\] read/);
  assert.match(ok, /src\/index\.ts/);
  assert.match(ok, /✓/);
});

test("runTimelineRow renders [t] + ✗ + full error text for failed tools", () => {
  const bad = runTimelineRow({ type: "tool", toolName: "bash", args: "pnpm test:run", result: "Error: test not found", isError: true, turnIndex: 1 });
  assert.match(bad, /\[t\] bash/);
  assert.match(bad, /✗/);
  assert.match(bad, /Error: test not found/);
});

test("runTimelineRow clamps turnIndex -1 to 0 (cosmetic; no crash)", () => {
  const line = runTimelineRow({ type: "message", role: "assistant", text: "x", turnIndex: -1 });
  assert.match(line, /\[a\]/); // does not throw
});

test("runsRow: ctx% + $ shown when contextTokens/costTotal/maxContext present (SPEC-6-1)", () => {
  const resolver = (model: string) => (model === "m" ? 256000 : undefined);
  const line = runsRow(meta({ contextTokens: 128000, costTotal: 0.0123 }), resolver);
  assert.match(line, /50%/, `ctx% shown: ${line}`);
  assert.match(line, /\$0\.0123/, `cost shown: ${line}`);
});

test("runsRow: ctx% hidden when maxContext unresolved; $ hidden when costTotal 0 (SPEC-6-1)", () => {
  const line = runsRow(meta({ contextTokens: 100, costTotal: 0 }), () => undefined);
  assert.doesNotMatch(line, /%/, `no ctx% without maxContext: ${line}`);
  assert.doesNotMatch(line, /\$/, `no $ when costTotal 0: ${line}`);
});