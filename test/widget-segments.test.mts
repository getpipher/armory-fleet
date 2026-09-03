// test/widget-segments.test.mts — segment model for the colorized component widget (#104).
// Contract: widgetSegments(runs, now) concatenated == renderWidgetLines(runs, now) (byte-identity),
// with semantic tags (status on glyphs, muted/dim/text tokens on meta/numbers).
import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import {
  toWidgetRun, toWidgetRunFromBg, renderWidgetLines, widgetSegments, widgetTotalsSegments,
  type WidgetRun,
} from "../src/panel/widget-rows.ts";
import type { RunRecord } from "../src/engine/run-registry.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const fg = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "fl-fg1", agent: "coder", model: "m", task: "t", track: true, todoId: null,
  status: "running", startedAt: 1000, cwd: "/", backend: "pi", ...over,
});

const bg = (over: Partial<BgRunStatus> = {}): BgRunStatus => ({
  runId: "fl-bg1", lifecycle: "default", status: "running", phase: "implement",
  phaseIndex: 2, phaseTotal: 5, mode: "auto", backend: "pi", task: "bg task", ...over,
});

const join = (lines: { text: string }[][]): string[] => lines.map((line) => line.map((s) => s.text).join(""));

test("segments concatenate byte-identically to renderWidgetLines (fg, bg, cap, footer)", () => {
  const single: WidgetRun[] = [toWidgetRun(fg({ task: "refactor the parser", contextTokens: 265_055 }))];
  deepStrictEqual(join(widgetSegments(single, 3000)), renderWidgetLines(single, 3000));

  const bgRuns: WidgetRun[] = [toWidgetRunFromBg(bg())];
  deepStrictEqual(join(widgetSegments(bgRuns, 1000)), renderWidgetLines(bgRuns, 1000));

  const many: WidgetRun[] = Array.from({ length: 7 }, (_, i) =>
    toWidgetRun(fg({ runId: `fl-${i}`, status: "running", startedAt: 1000 + i })));
  deepStrictEqual(join(widgetSegments(many, 2000)), renderWidgetLines(many, 2000));

  const longRunning: WidgetRun[] = [toWidgetRun(fg({ task: "long haul", startedAt: 0, lastEventAt: 500 }))];
  deepStrictEqual(join(widgetSegments(longRunning, 40_000)), renderWidgetLines(longRunning, 40_000));

  deepStrictEqual(join(widgetSegments([], 1000)), renderWidgetLines([], 1000));
});

test("glyph segments carry the run status; meta segments carry muted; numbers carry text", () => {
  const runs: WidgetRun[] = [toWidgetRun(fg({
    task: "refactor", agent: "coder", contextTokens: 5000, costTotal: 0.02,
    turnCount: 3, turnMax: 10, lastEventClass: "tool:edit", lastEventAt: 2000, startedAt: 0,
  }))];
  const lines = widgetSegments(runs, 40_000);
  const row = lines[0]!;
  ok((row[0]!.status === "running"), `glyph segment carries status: ${JSON.stringify(row[0])}`);
  ok(row.some((s) => s.token === "muted" && s.text.includes("turn 3/10")), "turn segment muted");
  ok(row.some((s) => s.token === "muted" && s.text.includes("●tool:edit")), "event segment muted");
  ok(row.some((s) => s.token === "text" && s.text.includes("tok")), "tok segment text");
  ok(row.some((s) => s.token === "text" && s.text.includes("$")), "cost segment text");
});

test("stale segment carries status stale; cross-cwd segment carries dim", () => {
  const stale: WidgetRun[] = [toWidgetRun(fg({ task: "hang", startedAt: 0, lastEventAt: 0 }))];
  const staleLines = widgetSegments(stale, 90_000);
  const flat = staleLines.flat();
  ok(flat.some((s) => s.status === "stale" && s.text.includes("⏰stale")), "stale segment tagged stale");
  const cross: WidgetRun[] = [toWidgetRun(fg({ cwd: "/other/repo", sessionCwd: "/home" }))];
  const crossLines = widgetSegments(cross, 2000);
  ok(crossLines.flat().some((s) => s.token === "dim" && s.text.includes("↗")), "cross-cwd segment dim");
});

test("totals strip: present only when >1 active, glyph carries running, money/tok text", () => {
  const one = widgetTotalsSegments([toWidgetRun(fg())], 2000);
  strictEqual(one.length, 0, "single active → no totals strip");
  const two = widgetTotalsSegments([
    toWidgetRun(fg({ costTotal: 0.5, contextTokens: 1300 })),
    toWidgetRunFromBg(bg({ status: "queued" })),
  ], 2000);
  ok(two.length > 0, "totals strip present for 2 actives");
  ok(two[0]!.status === "running", "totals glyph carries running");
  ok(two.some((s) => s.token === "text" && /^\$\d/.test(s.text)), "money segment");
  ok(two.some((s) => s.token === "text" && s.text.includes("K tok")), "tok segment");
});
