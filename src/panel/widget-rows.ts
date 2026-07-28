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
import type { RunRecord } from "../engine/run-registry.ts";
import type { BgRunStatus } from "./rows.ts";

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
  /** SPEC-6-1: max context window for the resolved model (set by controller — Task 7). */
  maxContext?: number;
  /** SPEC-6-1: cumulative $ (for the $ segment). */
  costTotal?: number;
}

export function toWidgetRun(r: RunRecord): WidgetRun {
  return {
    runId: r.runId, agent: r.agent, status: r.status,
    startedAt: r.startedAt, endedAt: r.endedAt, tokenTotal: r.tokenTotal,
    kind: "fg",
    task: r.task, costTotal: r.costTotal, contextTokens: r.contextTokens,
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
  const agentSeg = r.agent && r.agent !== "general-purpose" ? `  · ${r.agent}` : "";
  return `${glyph} ${label}${agentSeg}${dur}${tok}${ctx}${cost}`;
}

/** Above-editor widget: one line per active run, cap 5, overflow → "+N more in /fleet". */
export function renderWidgetLines(runs: WidgetRun[], now: number = Date.now()): string[] {
  const active = filterActive(runs);
  const cap = 5;
  if (active.length <= cap) return active.map((r) => widgetLine(r, now));
  const shown = active.slice(0, cap).map((r) => widgetLine(r, now));
  shown.push(`+${active.length - cap} more in /fleet`);
  return shown;
}

