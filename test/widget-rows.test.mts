// test/widget-rows.test.mts
import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { basename } from "node:path";
import {
  toWidgetRun, toWidgetRunFromBg, filterActive, renderWidgetLines,
  type WidgetRun,
} from "../src/panel/widget-rows.ts";
import { fmtTokens } from "../src/panel/rows.ts";
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

test("#23 liveness: short fg run (< threshold) stays concise — no turn/last-event segments", () => {
  const now = 1000 + 5_000; // 5s elapsed
  const w = toWidgetRun(fg({ startedAt: 1000, task: "do thing", agent: "coder" }));
  const lines = renderWidgetLines([w], now);
  const line = lines[0];
  ok(!line!.includes("turn "), `short run has no turn segment: ${line}`);
  ok(!line!.includes("●"), `short run has no last-event glyph: ${line}`);
});

test("#23 liveness: long fg run (> threshold) shows turn N/max + last-event class", () => {
  const startedAt = 1000;
  const now = startedAt + 45_000; // 45s elapsed > 30s threshold
  const w = toWidgetRun(fg({ startedAt, task: "long task", agent: "coder", turnCount: 3, turnMax: 20, lastEventClass: "tool:edit" }));
  const lines = renderWidgetLines([w], now);
  const line = lines[0]!;
  ok(line!.includes("turn 3/20"), `long run shows turn count: ${line}`);
  ok(line!.includes("●tool:edit"), `long run shows last-event class: ${line}`);
});

test("#23 liveness: long fg run appends the abort-warning footer naming the runId", () => {
  const startedAt = 1000;
  const now = startedAt + 45_000;
  const w = toWidgetRun(fg({ runId: "fl-abcd12-34", startedAt, task: "x", turnCount: 2, turnMax: 20, lastEventClass: "assistant" }));
  const lines = renderWidgetLines([w], now);
  ok(lines.length === 2, `long fg run → 1 run line + 1 warning footer; got ${lines.length}`);
  const warning = lines[1]!;
  ok(warning.includes("aborts the foreground run"), `warning mentions abort: ${warning}`);
  ok(warning.includes("fl-abcd12-34"), `warning names the runId: ${warning}`);
  ok(warning.includes("/fleet"), `warning points to /fleet: ${warning}`);
});

test("#23 liveness: short fg run does NOT append the abort-warning footer", () => {
  const now = 1000 + 5_000; // 5s elapsed < threshold
  const w = toWidgetRun(fg({ runId: "fl-short1", startedAt: 1000, task: "quick" }));
  const lines = renderWidgetLines([w], now);
  ok(lines.length === 1, `short fg run → just the run line, no warning; got ${lines.length}`);
});

test("#23 liveness: bg runs do not get the fg abort warning", () => {
  // A bg run has no startedAt-based elapsed in the fg sense; the warning is fg-only.
  const w = toWidgetRunFromBg(bg({ runId: "fl-bgwarn", status: "running" }));
  const lines = renderWidgetLines([w], Date.now());
  ok(!lines.some((l) => l.includes("aborts the foreground run")), `bg run → no fg abort warning: ${lines.join("|")}`);
});

test("#23 liveness: stale indicator when no event for > STALE_THRESHOLD_MS", () => {
  // A long run whose last event was > 60s ago shows ⏰stale (events NOT still arriving → maybe hung).
  const startedAt = 1000;
  const now = startedAt + 45_000; // 45s elapsed > 30s liveness threshold
  const lastEventAt = now - 70_000; // last event 70s ago > 60s stale threshold
  const w = toWidgetRun(fg({ startedAt, task: "x", turnCount: 2, turnMax: 20, lastEventClass: "tool:edit", lastEventAt }));
  const lines = renderWidgetLines([w], now);
  ok(lines[0]!.includes("⏰stale"), `stale indicator shown when last event > 60s ago: ${lines[0]}`);
});

test("#23 liveness: no stale indicator when events arrived recently", () => {
  const startedAt = 1000;
  const now = startedAt + 45_000;
  const lastEventAt = now - 5_000; // last event 5s ago < 60s
  const w = toWidgetRun(fg({ startedAt, task: "x", turnCount: 2, turnMax: 20, lastEventClass: "assistant", lastEventAt }));
  const lines = renderWidgetLines([w], now);
  ok(!lines[0]!.includes("stale"), `no stale indicator when events recent: ${lines[0]}`);
});

test("#23 liveness: paused fg run does NOT trigger the abort-warning footer", () => {
  // A paused fg run isn't aborted by a new message (it's resumed). The footer must require status:running.
  // NOTE: a fg run can't actually be "paused" via toWidgetRun (FleetRunStatus has no paused/queued —
  // those come from bg runs), so build the WidgetRun directly to test the defensive guard.
  const startedAt = 1000;
  const now = startedAt + 45_000; // > threshold
  const w: WidgetRun = { runId: "fl-paused1", agent: "coder", status: "paused", startedAt, kind: "fg", task: "x", turnCount: 2, turnMax: 20, lastEventClass: "assistant" };
  const lines = renderWidgetLines([w], now);
  ok(!lines.some((l) => l.includes("aborts the foreground run")), `paused fg run → no abort warning: ${lines.join("|")}`);
});

test("#23 liveness: running fg run > threshold DOES trigger the abort-warning footer", () => {
  // Regression guard: status:running (the default) + > threshold → footer fires.
  const startedAt = 1000;
  const now = startedAt + 45_000;
  const w = toWidgetRun(fg({ runId: "fl-running1", startedAt, task: "x", status: "running", turnCount: 2, turnMax: 20, lastEventClass: "assistant" }));
  const lines = renderWidgetLines([w], now);
  ok(lines.some((l) => l.includes("aborts the foreground run")), `running fg run > threshold → footer fires: ${lines.join("|")}`);
});

test("#32 substrate label: fg run past turn 1 with flat context growth → labeled 'substrate'", () => {
  // Substrate-dominated run: turn-1 baseline 575K, turn 2+ barely grew (+0.2%). The tok/ctx%
  // segment reads as frozen; the 'substrate' label explains it's flat overhead, not stuck work.
  const w = toWidgetRun(fg({
    startedAt: 1000, task: "review the PR", agent: "coder",
    turnCount: 3, turnMax: 20,
    contextTokens: 576_000, substrateBaseline: 575_000, // +0.17% growth ≤ 5% threshold
  }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes("  substrate"), `flat growth → 'substrate' label: ${lines[0]}`);
  ok(!lines[0]!.includes("  work"), `flat growth → not 'work': ${lines[0]}`);
});

test("#32 substrate label: fg run past turn 1 with real context growth → labeled 'work'", () => {
  // Work-growing run: turn-1 baseline 575K, but tool results added 80K (+13.9% > 5%) → 'work'.
  const w = toWidgetRun(fg({
    startedAt: 1000, task: "refactor module", agent: "coder",
    turnCount: 4, turnMax: 20,
    contextTokens: 655_000, substrateBaseline: 575_000, // +13.9% growth > 5% threshold
  }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes("  work"), `growing context → 'work' label: ${lines[0]}`);
  ok(!lines[0]!.includes("  substrate"), `growing context → not 'substrate': ${lines[0]}`);
});

test("#32 substrate label: exactly at the 5% threshold → 'substrate' (≤ threshold)", () => {
  const w = toWidgetRun(fg({
    startedAt: 1000, task: "edge", agent: "coder",
    turnCount: 2, turnMax: 20,
    contextTokens: 603_750, substrateBaseline: 575_000, // +5.0% exactly → ≤ threshold → substrate
  }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes("  substrate"), `growth == threshold → 'substrate' (≤): ${lines[0]}`);
});

test("#32 substrate label: turn 1 only (turnCount < 2) → no label (baseline just established)", () => {
  // Only one turn of data — nothing to compare against yet. No substrate/work label.
  const w = toWidgetRun(fg({
    startedAt: 1000, task: "just started", agent: "coder",
    turnCount: 1, turnMax: 20,
    contextTokens: 575_000, substrateBaseline: 575_000,
  }));
  const lines = renderWidgetLines([w], 2000);
  ok(!lines[0]!.includes("  substrate"), `turn 1 → no substrate label: ${lines[0]}`);
  ok(!lines[0]!.includes("  work"), `turn 1 → no work label: ${lines[0]}`);
});

test("#32 substrate label: past turn 1 but no baseline captured → no label", () => {
  // Defensive: if the baseline was never set (e.g. turn 1 produced no assistant message_end),
  // there's no reference to classify against — no label rather than a misleading one.
  const w = toWidgetRun(fg({
    startedAt: 1000, task: "no baseline", agent: "coder",
    turnCount: 3, turnMax: 20,
    contextTokens: 580_000, // substrateBaseline undefined
  }));
  const lines = renderWidgetLines([w], 2000);
  ok(!lines[0]!.includes("  substrate"), `no baseline → no substrate label: ${lines[0]}`);
  ok(!lines[0]!.includes("  work"), `no baseline → no work label: ${lines[0]}`);
});

test("#32 substrate label: bg runs never get a substrate/work label", () => {
  // bg runs don't carry substrateBaseline (toWidgetRunFromBg doesn't set it) and have no turnCount;
  // the label is a fg-only signal.
  const w = toWidgetRunFromBg(bg({ runId: "fl-bgsub", status: "running" }));
  const lines = renderWidgetLines([w], Date.now());
  ok(!lines.some((l) => l.includes("  substrate") || l.includes("  work")), `bg run → no substrate/work label: ${lines.join("|")}`);
});

test("SPEC-6-5: cross-cwd fg run shows the ↗<basename> glyph", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", startedAt: 1000, task: "do", cwd: "/Users/r/projB", sessionCwd: "/Users/r/projA" }));
  const lines = renderWidgetLines([w], 2000);
  ok(lines[0]!.includes(`↗${basename("/Users/r/projB")}`), `cross-cwd glyph: ${lines[0]}`);
});

test("SPEC-6-5: same-cwd fg run has no ↗ glyph", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", startedAt: 1000, task: "do", cwd: "/session", sessionCwd: "/session" }));
  const lines = renderWidgetLines([w], 2000);
  ok(!lines[0]!.includes("↗"), `same-cwd → no glyph: ${lines[0]}`);
});
