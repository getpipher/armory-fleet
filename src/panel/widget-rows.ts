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
}

export function toWidgetRun(r: RunRecord): WidgetRun {
  return {
    runId: r.runId, agent: r.agent, status: r.status,
    startedAt: r.startedAt, endedAt: r.endedAt, tokenTotal: r.tokenTotal,
    kind: "fg",
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

/** One compact line per active run. */
function widgetLine(r: WidgetRun, now: number): string {
  const glyph = STATUS_GLYPH[r.status];
  const dur = typeof r.startedAt === "number" ? `  ${fmtDuration(now - r.startedAt)}` : "";
  const tok = r.tokenTotal ? `  ${fmtTokens(r.tokenTotal)} tok` : "";
  const phase = r.phase ? `  ●${r.phase} ${r.phaseIndex ?? 0}/${r.phaseTotal ?? 0}` : "";
  const be = r.backend ? `  ${r.backend}` : "";
  return `${glyph} ${r.runId}  ${r.agent}${dur}${tok}${phase}${be}`;
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

