// test/widget-rows.test.mts
import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import {
  toWidgetRun, toWidgetRunFromBg, filterActive, renderWidgetLines,
  type WidgetRun,
} from "../src/panel/widget-rows.ts";
import { fmtTokens } from "../src/panel/rows.ts";
import type { RunRecord } from "../src/engine/run-registry.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const fg = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "fl-fg1", agent: "coder", model: "m", task: "t", track: true, todoId: null,
  status: "running", startedAt: 1000, ...over,
});

const bg = (over: Partial<BgRunStatus> = {}): BgRunStatus => ({
  runId: "fl-bg1", lifecycle: "default", status: "running", phase: "implement",
  phaseIndex: 2, phaseTotal: 5, mode: "auto", backend: "pi", task: "bg task", ...over,
});

test("toWidgetRun projects a RunRecord (fg kind)", () => {
  const w = toWidgetRun(fg({ tokenTotal: 142 }));
  strictEqual(w.kind, "fg");
  strictEqual(w.runId, "fl-fg1");
  strictEqual(w.startedAt, 1000);
  strictEqual(w.tokenTotal, 142);
  ok(w.phase === undefined, "fg runs have no phase");
});

test("toWidgetRunFromBg projects a BgRunStatus (bg kind, no startedAt)", () => {
  const w = toWidgetRunFromBg(bg());
  strictEqual(w.kind, "bg");
  strictEqual(w.runId, "fl-bg1");
  ok(w.startedAt === undefined, "bg runs have no startedAt");
  strictEqual(w.phase, "implement");
  strictEqual(w.phaseIndex, 2);
  strictEqual(w.phaseTotal, 5);
  strictEqual(w.backend, "pi");
  strictEqual(w.agent, "default", "bg agent label = lifecycle name");
});

test("filterActive keeps running/queued/paused; drops completed/failed/aborted; newest-first", () => {
  const runs: WidgetRun[] = [
    toWidgetRun(fg({ runId: "fl-a", status: "completed", startedAt: 3 })),
    toWidgetRun(fg({ runId: "fl-b", status: "running", startedAt: 1 })),
    toWidgetRun(fg({ runId: "fl-c", status: "running", startedAt: 5 })),
    toWidgetRunFromBg(bg({ runId: "fl-d", status: "queued" })),
    toWidgetRunFromBg(bg({ runId: "fl-e", status: "paused" })),
    toWidgetRunFromBg(bg({ runId: "fl-f", status: "failed" })),
  ];
  const active = filterActive(runs);
  deepStrictEqual(active.map((r) => r.runId), ["fl-c", "fl-b", "fl-d", "fl-e"], "running/queued/paused kept, completed/failed dropped, fg-newest-first with bg after (no startedAt)");
});

test("renderWidgetLines: one line per active run, capped at 5 + overflow", () => {
  const runs: WidgetRun[] = Array.from({ length: 7 }, (_, i) =>
    toWidgetRun(fg({ runId: `fl-${i}`, status: "running", startedAt: 1000 + i })),
  );
  const lines = renderWidgetLines(runs, 2000);
  strictEqual(lines.length, 6, "5 shown + 1 overflow");
  ok(lines[5]!.includes("+2 more in /fleet"), "overflow line");
});

test("renderWidgetLines: fg row shows glyph + task excerpt + named agent + live duration + tokens", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", agent: "coder", task: "refactor the module", startedAt: 1000, contextTokens: 142 }));
  const lines = renderWidgetLines([w], 3000);
  strictEqual(lines.length, 1);
  ok(lines[0]!.includes("▶"), "running glyph");
  ok(lines[0]!.includes('"refactor the module"'), `task excerpt shown: ${lines[0]}`);
  ok(!lines[0]!.includes("fl-x"), "runId hidden from widget row");
  ok(lines[0]!.includes("· coder"), `named agent shown: ${lines[0]}`);
  ok(lines[0]!.includes("2s"), `live duration: ${lines[0]}`);
  ok(lines[0]!.includes("142 tok"), "token segment");
  ok(!lines[0]!.includes("●"), "fg row has no phase segment");
});

test("renderWidgetLines: bg row shows phase segment, no runId, no duration", () => {
  const w = toWidgetRunFromBg(bg({ runId: "fl-bg", phase: "plan", phaseIndex: 1, phaseTotal: 4 }));
  const lines = renderWidgetLines([w], 1000);
  strictEqual(lines.length, 1);
  ok(lines[0]!.includes("●plan 1/4"), "phase segment");
  ok(!lines[0]!.includes("fl-bg"), "runId hidden from bg widget row");
});

test("renderWidgetLines: empty input → empty array", () => {
  deepStrictEqual(renderWidgetLines([], 1000), []);
});
test("fmtTokens: K formatting for large counts (SPEC-6-1 UX)", () => {
  strictEqual(fmtTokens(142), "142", "<1K as-is");
  strictEqual(fmtTokens(1300), "1.3K", "1 decimal under 10K");
  strictEqual(fmtTokens(265055), "265K", "0 decimals >=10K");
  strictEqual(fmtTokens(2027001), "2027K", "millions in K");
});

test("widgetLine: ctx% shown when contextTokens + maxContext present (SPEC-6-1)", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", contextTokens: 128000, costTotal: 0.0123 } as any));
  w.maxContext = 256000;
  const lines = renderWidgetLines([w], 3000);
  ok(lines[0]!.includes("50%"), `ctx% shown: ${lines[0]}`);
  ok(lines[0]!.includes("$0.0123"), `cost shown: ${lines[0]}`);
});

test("widgetLine: ctx% hidden when maxContext absent; $ hidden when costTotal 0", () => {
  const w = toWidgetRun(fg({ runId: "fl-y", contextTokens: 100, costTotal: 0 } as any));
  const lines = renderWidgetLines([w], 3000);
  ok(!lines[0]!.includes("%"), `no ctx% without maxContext: ${lines[0]}`);
  ok(!lines[0]!.includes("$"), `no $ when costTotal 0: ${lines[0]}`);
});

test("widgetLine: general-purpose agent hidden from row; named agent shown", () => {
  const wGeneric = toWidgetRun(fg({ runId: "fl-g", agent: "general-purpose", task: "do stuff", startedAt: 1000 }));
  const linesG = renderWidgetLines([wGeneric], 2000);
  ok(linesG[0]!.includes('"do stuff"'), `task excerpt shown: ${linesG[0]}`);
  ok(!linesG[0]!.includes("general-purpose"), `generic agent hidden: ${linesG[0]}`);
  ok(!linesG[0]!.includes("fl-g"), "runId hidden");

  const wNamed = toWidgetRun(fg({ runId: "fl-n", agent: "scout", task: "recon", startedAt: 1000 }));
  const linesN = renderWidgetLines([wNamed], 2000);
  ok(linesN[0]!.includes("· scout"), `named agent shown: ${linesN[0]}`);
});

test("widgetLine: task excerpt truncated to 40 chars", () => {
  const longTask = "delegate to scout and recon the entire repository structure and report back";
  const w = toWidgetRun(fg({ runId: "fl-l", agent: "scout", task: longTask, startedAt: 1000 }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes('"delegate to scout and recon the entire r"'), `truncated to 40 chars: ${lines[0]}`);
  ok(!lines[0]!.includes("repository structure"), "beyond 40 chars not shown");
});

test("widgetLine: fg run with no task falls back to runId", () => {
  const w = toWidgetRun(fg({ runId: "fl-notask", agent: "coder", task: "", startedAt: 1000 }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes("fl-notask"), `runId fallback when no task: ${lines[0]}`);
});
