// src/panel/present.ts — pure panel presentation helpers (#104 velocity bundle).
// Totals line, state-machine footer, per-status capability table. No I/O.
import { GLYPHS, spinnerFrame } from "../present/glyphs.ts";
import { fmtTok } from "../transcript/run-card.ts";
import { visibleWidth } from "../present/width.ts";

export type PanelView = "fleet" | "lifecycle" | "runs" | "agents" | "backends" | "scheduled" | "tiers" | "workflows";

export interface FooterState {
  view: PanelView;
  mode: "browse" | "row-selected" | "modal" | "input" | "checkpoint";
  canSteer?: boolean;
  running?: boolean;
  aborted?: boolean;
  paused?: boolean;
}

/** Right-aligned totals header: `⣾ N running · ✓ N done · $X.XX · YK tok`-style.
 *  Zero segments are omitted; a fully quiet board renders the count-only (idle) form —
 *  the `—` honesty rule does NOT apply to totals (counts of nothing are the message). */
export function totalsLine(active: { status: string }[], opts: { costTotal?: number; contextTokens?: number } = {}, frame = 0): string {
  const spin = spinnerFrame(frame);
  const count = (s: string): number => active.filter((r) => r.status === s).length;
  const running = count("running");
  const queued = count("queued");
  const done = count("completed");
  const failed = count("failed") + count("aborted");
  const segs: string[] = [];
  if (running > 0) segs.push(`${spin} ${running} running`);
  if (queued > 0) segs.push(`${spin} ${queued} queued`);
  if (done > 0) segs.push(`${GLYPHS.status.completed} ${done} done`);
  if (failed > 0) segs.push(`${GLYPHS.status.failed} ${failed} failed`);
  if (opts.costTotal) segs.push(`$${opts.costTotal.toFixed(2)}`);
  if (opts.contextTokens) segs.push(fmtTok(opts.contextTokens));
  return segs.length > 0 ? segs.join(" · ") : `${spin} idle`;
}

/** P3: segmented footer hint bar — segments joined with the active preset's footerSep. */
export function hint(...parts: string[]): string {
  return parts.join(` ${GLYPHS.footerSep} `);
}

/** Per-view browse hints — key sets unchanged since #104; segments joined by hint(). */
const VIEW_HINTS: Record<PanelView, string[]> = {
  fleet: ["r:Run-new", "s:Steer", "x:Stop", "o:Open-todo", "t:Tree", "tab:Lifecycle", "q:Quit"],
  lifecycle: ["r:Run-lifecycle", "i:Info", "tab:Runs", "q:Quit"],
  runs: ["enter:Replay", "r:Resume", "f:Fork", "t:Tree", "tab:Agents", "q:Quit"],
  agents: ["r:Run", "e:Edit", "i:Info", "d:Reload", "tab:Backends", "q:Quit"],
  backends: ["r:Refresh", "i:Info", "tab:Fleet", "q:Quit"],
  scheduled: ["a:Add", "p:Pause/resume", "d:Delete", "i:Info", "tab:Tiers", "q:Quit"],
  tiers: ["m:Models", "c:costCap", "f:contextFloor", "a:Add", "d:Delete", "g:scope", "tab:Workflows", "q:Quit"],
  workflows: ["r:Run", "e:Edit-and-resume", "o:Open", "p:Pause", "u:Resume", "x:Stop", "s:Save-as", "v:View-result", "tab:Fleet", "q:Quit"],
};

/** State-machine footer: mode overrides first (checkpoint/input/modal), then row-selected
 *  capability segments (fleet view), then the per-view browse hint. */
export function footerFor(state: FooterState): string {
  if (state.mode === "checkpoint") return hint("c:Continue", "v:Revise", "a:Abort");
  if (state.mode === "input") return hint("enter:Submit-feedback", "esc:Cancel");
  if (state.mode === "modal") return hint("esc:Back");
  if (state.mode === "row-selected") {
    if (state.view === "lifecycle") return hint("v:View-evidence", "g:Re-run-gate", "esc:Back");
    if (state.view !== "fleet") return hint("enter:Full-message", "esc:Back");
    const segs = ["enter:Full-message", "esc:Back"];
    if (state.running) {
      if (state.canSteer !== false) segs.push("s:Steer");
      segs.push("x:Stop");
    } else if (state.paused) {
      segs.push("u:Resume");
    } else if (state.aborted) {
      segs.push("↻:Re-run");
    }
    return hint(...segs);
  }
  return hint(...VIEW_HINTS[state.view]);
}

/** Capability table: which row actions exist for a run in a given status. */
export function actionsForRun(status: string): { key: string; label: string }[] {
  switch (status) {
    case "running": return [{ key: "s", label: "steer" }, { key: "x", label: "stop" }];
    case "paused": return [{ key: "u", label: "resume" }];
    case "aborted":
    case "failed": return [{ key: "R", label: "re-run" }];
    default: return [];
  }
}

/** P2: tab row + right-aligned totals at the real terminal width (#104/#108 — was hardcoded 80).
 *  ANSI-aware: totals may carry theme escapes, so pad against visibleWidth. Floor 40. */
export function totalsHeader(tabLine: string, totals: string, width: number): string {
  const w = Math.max(40, width);
  const pad = Math.max(1, w - visibleWidth(tabLine) - visibleWidth(totals));
  return tabLine + " ".repeat(pad) + totals;
}

/** P2: timeline footer — while a live run streams AND the view is scrolled up
 *  (LiveTimelineState.pinned === false), the hint line becomes the detach marker.
 *  Re-follow gesture = existing scroll-to-bottom re-pin (no key changes; Enter keeps Full-message). */
export function timelineFooter(detached: boolean): string {
  return detached ? `  ${hint("↑ scrolled", "live paused", "↓ end to re-follow")}` : "  enter:Full-message  esc:Back";
}
