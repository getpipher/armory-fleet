// src/panel/widget-rows.ts
// SPEC-5b-2 — pure render functions for the live widget (above editor).
// Display-only; plain strings (no theme) — theming, if wanted, is applied at the setWidget boundary.
// Mirrors the runs-rows/fleet-items pure-renderer convention (unit-tested, no TUI).
//
// v0.9.2 (fix/spec-5b-2): the below-editor FleetView widget was removed — it was a display-only
// mirror of this same renderer (same `widgetLine`, cap 8 vs 5), and the PRD §5 "navigable agent
// list below editor" intent was never achievable via pi widgets (editor keeps keyboard focus).
// `/fleet` is the navigable action surface; this one above-editor widget is the glance surface.
import { fmtDuration, fmtTokens } from "./rows.ts";
import { basename } from "node:path";
import type { RunRecord } from "../engine/run-registry.ts";
import type { BgRunStatus } from "./rows.ts";

/** #23: liveness segments (turn count, last-event class, abort warning) appear only after a run
 *  has been active this long — keeps short foreground runs concise (per #23 acceptance criteria). */
export const LIVENESS_THRESHOLD_MS = 30_000;
/** #23: a run whose last event is older than this is flagged stale ("are events still arriving?"). */
export const STALE_THRESHOLD_MS = 60_000;
/** #32: once past turn 1, if contextTokens has grown by less than this fraction of the
 *  turn-1 substrate baseline, the tok/ctx% segment is labeled "substrate" (flat overhead)
 *  rather than "work" (growing from tool results). 5% — the dogfood evidence showed ~0.2%/turn
 *  growth on a substrate-dominated run vs tens-of-K (multi-%) once real tool output lands. */
export const SUBSTRATE_GROWTH_THRESHOLD = 0.05;

export interface WidgetRun {
  runId: string;
  agent: string;
  status: "running" | "queued" | "paused" | "completed" | "failed" | "aborted";
  /** fg runs have startedAt (live duration); bg runs do not (show phase instead). */
  startedAt?: number;
  endedAt?: number;
  tokenTotal?: number;
  phase?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  kind: "fg" | "bg";
  backend?: string;
  /** SPEC-6-1: task excerpt for the primary label (fg runs). */
  task?: string;
  /** SPEC-6-1: latest context-token snapshot (for ctx% segment). */
  contextTokens?: number;
  /** #32: context-token baseline at end of turn 1 (armory substrate overhead). When the
   *  current contextTokens has grown little beyond this baseline across turns, the tok/ctx%
   *  segment is labeled "substrate" (flat overhead) vs "work" (growing from tool results). */
  substrateBaseline?: number;
  /** SPEC-6-1: max context window for the resolved model (set by controller — Task 7). */
  maxContext?: number;
  /** SPEC-6-1: cumulative $ (for the $ segment). */
  costTotal?: number;
  /** #23: liveness — current turn count (1-indexed). */
  turnCount?: number;
  /** #23: liveness — max turn budget (for `turn N/max`). */
  turnMax?: number;
  /** #23: liveness — last event class (e.g. "tool:edit", "assistant", "turn"). */
  lastEventClass?: string;
  /** #23: liveness — timestamp (ms) of the last event ("events still arriving?"). */
  lastEventAt?: number;
  /** SPEC-6-5: the run's (child) cwd — from RunRecord.cwd. */
  cwd?: string;
  /** SPEC-6-5: the session cwd (parentCwd) — from RunRecord.sessionCwd. When cwd !== sessionCwd the widget shows a ↗ glyph. */
  sessionCwd?: string;
}

export function toWidgetRun(r: RunRecord): WidgetRun {
  return {
    runId: r.runId, agent: r.agent, status: r.status,
    startedAt: r.startedAt, endedAt: r.endedAt, tokenTotal: r.tokenTotal,
    kind: "fg",
    task: r.task, costTotal: r.costTotal, contextTokens: r.contextTokens, substrateBaseline: r.substrateBaseline,
    turnCount: r.turnCount, turnMax: r.turnMax, lastEventClass: r.lastEventClass, lastEventAt: r.lastEventAt,
    cwd: r.cwd, sessionCwd: r.sessionCwd,
  };
}

export function toWidgetRunFromBg(b: BgRunStatus): WidgetRun {
  return {
    runId: b.runId, agent: b.lifecycle, status: b.status,
    phase: b.phase, phaseIndex: b.phaseIndex, phaseTotal: b.phaseTotal,
    kind: "bg", backend: b.backend,
  };
}

/** Active = not-done = {running, queued, paused}. Newest-first by startedAt desc;
 *  runs without startedAt (bg) keep stable trailing order. */
export function filterActive(runs: WidgetRun[]): WidgetRun[] {
  const active = runs.filter((r) => r.status === "running" || r.status === "queued" || r.status === "paused");
  return active.sort((a, b) => {
    const ai = typeof a.startedAt === "number" ? a.startedAt : Number.MIN_SAFE_INTEGER;
    const bi = typeof b.startedAt === "number" ? b.startedAt : Number.MIN_SAFE_INTEGER;
    return bi - ai; // newest-first
  });
}

const STATUS_GLYPH: Record<WidgetRun["status"], string> = {
  running: "▶", queued: "⏳", paused: "⏸", completed: "✓", failed: "✗", aborted: "✗",
};

/** One compact line per active run.
 *  fg: `▶ "task excerpt"  · agent  5s  265K tok  42%  $0.01` (runId hidden; agent hidden when general-purpose).
 *  bg: `▶ ●plan 2/4  pi` (phase as primary label; no runId, no task excerpt). */
function widgetLine(r: WidgetRun, now: number): string {
  const glyph = STATUS_GLYPH[r.status];
  const dur = typeof r.startedAt === "number" ? `  ${fmtDuration(now - r.startedAt)}` : "";
  // SPEC-6-1 fix: "tok" is the live context snapshot (contextTokens), NOT cumulative
  // tokenTotal — it pairs with the ctx% segment (same metric). Showing tokenTotal here
  // ballooned to 6.7M on long runs (cumulative re-sends) next to a 35% ctx, looking broken.
  const tok = r.contextTokens != null ? `  ${fmtTokens(r.contextTokens)} tok` : "";
  const ctx = (r.contextTokens != null && r.maxContext != null && r.maxContext > 0) ? `  ${Math.round(r.contextTokens / r.maxContext * 100)}%` : "";
  const cost = r.costTotal ? `  $${r.costTotal.toFixed(4)}` : "";

  if (r.kind === "bg") {
    const phase = r.phase ? `●${r.phase} ${r.phaseIndex ?? 0}/${r.phaseTotal ?? 0}` : r.runId;
    const be = r.backend ? `  ${r.backend}` : "";
    return `${glyph} ${phase}${tok}${be}`;
  }

  // fg: task excerpt as primary label (fallback to runId if no task)
  const label = r.task ? `"${r.task.slice(0, 40)}"` : r.runId;
  // SPEC-6-5: cross-cwd glyph — when the run's cwd differs from the session cwd, mark it so the
  // operator sees "this run is scoped to a different project" at a glance. Same-cwd → no glyph.
  // #62 NIT: isolated runs pin cwd to <child-cwd>/.pi/fleet/worktrees/<runId> — the basename
  // was the cryptic run-id. Strip the worktrees suffix so the glyph names the TARGET repo dir.
  const displayCwd = (cwd: string): string => {
    const wt = cwd.indexOf("/.pi/fleet/worktrees/");
    return wt > 0 ? basename(cwd.slice(0, wt)) : basename(cwd);
  };
  const crossCwd = (r.cwd && r.sessionCwd && r.cwd !== r.sessionCwd) ? `  ↗${displayCwd(r.cwd)}` : "";
  const agentSeg = r.agent && r.agent !== "general-purpose" ? `  · ${r.agent}` : "";
  // #23: liveness — only after LIVENESS_THRESHOLD_MS, to keep short runs concise (per acceptance).
  // turn N/max + last-event class (no prompt content, no args/results — only the tool name)
  // + a stale indicator if no event has arrived for STALE_THRESHOLD_MS ("events still arriving?").
  const elapsed = typeof r.startedAt === "number" ? now - r.startedAt : 0;
  let liveness = "";
  if (elapsed > LIVENESS_THRESHOLD_MS) {
    const turn = (r.turnCount != null && r.turnMax != null) ? `  turn ${r.turnCount}/${r.turnMax}` : (r.turnCount != null ? `  turn ${r.turnCount}` : "");
    const ev = r.lastEventClass ? `  ●${r.lastEventClass}` : "";
    const stale = (r.lastEventAt != null && now - r.lastEventAt > STALE_THRESHOLD_MS) ? "  ⏰stale" : "";
    liveness = `${turn}${ev}${stale}`;
  }
  // #32: substrate vs work — once past turn 1, classify the tok/ctx% segment. The armory substrate
  // (system prompt + skills + memory) dominates turn-1 context; on substrate-dominated runs the
  // ctx% barely moves across turns and reads as "frozen". Label it "substrate" (flat overhead) so
  // that's distinguishable from "work" (context growing from tool results). Needs ≥2 turns of
  // data (a baseline + a current snapshot); before that there's nothing to compare.
  let substrate = "";
  if ((r.turnCount ?? 0) >= 2 && r.substrateBaseline != null && r.contextTokens != null && r.substrateBaseline > 0) {
    const growth = (r.contextTokens - r.substrateBaseline) / r.substrateBaseline;
    substrate = growth <= SUBSTRATE_GROWTH_THRESHOLD ? "  substrate" : "  work";
  }
  return `${glyph} ${label}${crossCwd}${agentSeg}${dur}${liveness}${tok}${ctx}${substrate}${cost}`;
}

/** Above-editor widget: one line per active run, cap 5, overflow → "+N more in /fleet".
 *  #23: when an active foreground run has been running longer than LIVENESS_THRESHOLD_MS, append an
 *  explicit abort-warning footer naming its runId (so the controller can distinguish active work
 *  from a hang without cancelling, and knows submitting a message will abort it). */
export function renderWidgetLines(runs: WidgetRun[], now: number = Date.now()): string[] {
  const active = filterActive(runs);
  const cap = 5;
  const lines = active.length <= cap
    ? active.map((r) => widgetLine(r, now))
    : [...active.slice(0, cap).map((r) => widgetLine(r, now)), `+${active.length - cap} more in /fleet`];
  // #23: abort-warning footer — only when a RUNNING foreground run is active long enough that
  // a controller might worry it's hung. Paused/queued fg runs aren't aborted by a new message.
  const longFg = active.find((r) => r.kind === "fg" && r.status === "running" && typeof r.startedAt === "number" && now - r.startedAt > LIVENESS_THRESHOLD_MS);
  if (longFg) {
    lines.push(`⚠ submitting a message aborts the foreground run · ${longFg.runId} · /fleet to inspect`);
  }
  return lines;
}

