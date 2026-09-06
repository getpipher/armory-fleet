// src/transcript/run-card.ts — pure card builders (#104): live framed card + honest final line.
// No I/O, no Date.now() — `now` is passed in (replay-safe); theme is applied by the wiring task.
import { GLYPHS, spinnerFrame } from "../present/glyphs.ts";
import { visibleWidth, excerpt } from "../present/width.ts";
import { statusToken } from "../present/tokens.ts";
import type { RunCardState } from "./card-state.ts";

export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}
export function fmtTok(n?: number): string {
  if (n == null) return "—";
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)}K tok`;
}

/** P3: the card's live state line, extracted so the panel preview row mirrors it exactly.
 *  Segments: spinner, ●event, turn N, elapsed, tokens, ctx%. Missing optionals drop out. */
export function stateLine(s: RunCardState, now: number, frame: number): string {
  const spin = spinnerFrame(frame);
  return [
    spin,
    s.lastEventClass ? `${GLYPHS.eventDot}${s.lastEventClass}` : null,
    s.turnCount ? `turn ${s.turnCount}` : null,
    fmtDur(now - s.startedAt),
    s.contextTokens != null ? fmtTok(s.contextTokens) : null,
    s.contextTokens != null && s.maxContext ? `${Math.round((s.contextTokens / s.maxContext) * 100)}%` : null,
  ].filter((x): x is string => x != null && x !== "").join(" · ");
}

/** #108: cards clamp to this width regardless of terminal width — identical geometry everywhere. */
export const CARD_WIDTH = 72;

/** Live card (self-shell). 4 framed lines, each exactly `w` visible columns
 *  (w = max(width, head+8, 13+task, 13+state)); theme applied by the wiring task. */
export function liveCardLines(s: RunCardState, now: number, frame: number, width: number): string[] {
  const spin = spinnerFrame(frame);
  const task = excerpt(s.task, Math.max(20, width - 14));
  const state = stateLine(s, now, frame);
  // Spinner glues to the head with a space (test-pinned: `⣾ fleet · agent · model`), no dangling ·.
  const head = `${spin} ${["fleet", s.agent, s.model].filter((x): x is string => x != null && x !== "").join(" · ")}`;
  const w = Math.max(width, visibleWidth(head) + 8, 13 + visibleWidth(task), 13 + visibleWidth(state));
  const topBar = GLYPHS.cardH.repeat(Math.max(3, w - visibleWidth(head) - 5));
  const botBar = GLYPHS.cardH.repeat(Math.max(3, w - 2));
  const pad = (content: string): string => " ".repeat(Math.max(0, w - 11 - visibleWidth(content)));
  return [
    `${GLYPHS.cardTL}${GLYPHS.cardH} ${head} ${topBar}${GLYPHS.cardTR}`,
    `${GLYPHS.cardV}  task   ${task}${pad(task)}${GLYPHS.cardV}`,
    `${GLYPHS.cardV}  state  ${state}${pad(state)}${GLYPHS.cardV}`,
    `${GLYPHS.cardBL}${botBar}${GLYPHS.cardBR}`,
  ];
}

/** Final collapsed line. `—` honesty for missing fields; duration is replay-safe
 *  (`endedAt - startedAt`), never Date.now() — a non-terminal/absent endedAt renders "—"
 *  (live elapsed is liveCardLines' job, passed `now`). */
export function finalLine(s: RunCardState, theme: { fg(t: string, x: string): string }): string {
  const g = GLYPHS.status[s.status] ?? GLYPHS.status.queued;
  const parts = [
    theme.fg(statusToken(s.status).fg, `${g} ${s.agent}`),
    s.endedAt != null ? fmtDur(s.endedAt - s.startedAt) : "—",
    fmtTok(s.contextTokens),
    s.costTotal != null ? `$${s.costTotal.toFixed(2)}` : "—",
    s.filesTouched ? `${GLYPHS.filesTouched}${s.filesTouched}` : null,
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
