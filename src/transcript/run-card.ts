// src/transcript/run-card.ts — pure card builders (#104): live framed card + honest final line.
// No I/O, no Date.now() — `now` is passed in (replay-safe); theme is applied by the wiring task.
import { GLYPHS, spinnerFrame } from "../present/glyphs.ts";
import { visibleWidth, excerpt } from "../present/width.ts";
import type { RunCardState } from "./card-state.ts";

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}
function fmtTok(n?: number): string {
  if (n == null) return "—";
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)}K tok`;
}

/** Live card (self-shell). 4 framed lines; theme applied by the wiring task (plain here for testability). */
export function liveCardLines(s: RunCardState, now: number, frame: number, width: number): string[] {
  const spin = spinnerFrame(frame);
  const task = excerpt(s.task, Math.max(20, width - 14));
  const state = [
    spin,
    s.lastEventClass ? `●${s.lastEventClass}` : null,
    s.turnCount ? `turn ${s.turnCount}` : null,
    fmtDur(now - s.startedAt),
    s.contextTokens != null ? fmtTok(s.contextTokens) : null,
    s.contextTokens != null && s.maxContext ? `${Math.round((s.contextTokens / s.maxContext) * 100)}%` : null,
  ].filter(Boolean).join(" · ");
  const head = `${spin} fleet · ${s.agent} · ${s.model}`;
  const w = Math.max(width, visibleWidth(head) + 2, visibleWidth(`  state  ${state}`) + 4, visibleWidth(`  task   ${task}`) + 4);
  const bar = GLYPHS.cardH.repeat(Math.max(3, w - visibleWidth(head) - 3));
  return [
    `${GLYPHS.cardTL}─ ${head} ${bar}${GLYPHS.cardTR}`,
    `${GLYPHS.cardV}  task   ${task}${" ".repeat(Math.max(0, w - 9 - visibleWidth(task)))}${GLYPHS.cardV}`,
    `${GLYPHS.cardV}  state  ${state}${" ".repeat(Math.max(0, w - 9 - visibleWidth(state)))}${GLYPHS.cardV}`,
    `${GLYPHS.cardBL}${bar}${GLYPHS.cardBR}`,
  ];
}

/** Final collapsed line. `—` honesty for missing fields; duration is replay-safe
 *  (`endedAt - startedAt`), never Date.now() — a non-terminal/absent endedAt renders "—"
 *  (live elapsed is liveCardLines' job, passed `now`). */
export function finalLine(s: RunCardState, theme: { fg(t: string, x: string): string }): string {
  const g = GLYPHS.status[s.status] ?? GLYPHS.status.queued;
  const parts = [
    theme.fg(s.status, `${g} ${s.agent}`),
    s.endedAt != null ? fmtDur(s.endedAt - s.startedAt) : "—",
    fmtTok(s.contextTokens),
    s.costTotal != null ? `$${s.costTotal.toFixed(2)}` : "—",
    s.filesTouched ? `✎${s.filesTouched}` : null,
    s.toolCallCount != null ? `·${s.toolCallCount}t` : null,
  ].filter(Boolean);
  const tail = s.error
    ? ` ${theme.fg("error", `✗"${excerpt(s.error, 60)}"`)}`
    : s.resultSummary
      ? ` — ${excerpt(s.resultSummary, 60)}`
      : "";
  const warn = s.warnings?.length ? ` ${GLYPHS.gateWarn}${s.warnings.join(",")}` : "";
  return `${parts.join(" · ")}${tail}${warn}`;
}
