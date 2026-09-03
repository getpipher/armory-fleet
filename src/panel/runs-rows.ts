// src/panel/runs-rows.ts
// SPEC-5b-1 — pure renderers for the Runs tab + per-turn timeline. Reuses the glyph
// language (▶ ✓ ✗) so the Runs tab is visually consistent with Fleet/Lifecycle.
import { fmtDuration, fmtTokens } from "./rows.ts";
import { fg as statusFg, type FgTheme } from "../present/tokens.ts";
import type { RunMeta, MessageEvent, ToolEvent } from "../runtime/run-log.ts";

const STATUS_GLYPH: Record<RunMeta["status"], string> = {
  running: "▶", completed: "✓", failed: "✗", aborted: "✗",
};

export function runsRow(
  r: RunMeta,
  getModelContextWindow?: (model: string) => number | undefined,
  theme?: FgTheme,
): string {
  const dur = r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "—";
  // SPEC-6-1 fix: "tok" is the final context snapshot (contextTokens), NOT cumulative
  // tokenTotal — it pairs with the ctx% segment (same metric).
  const tok = r.contextTokens != null && r.contextTokens > 0 ? `  ${fmtTokens(r.contextTokens)} tok` : "";
  const maxCtx = getModelContextWindow?.(r.model);
  const ctx = (r.contextTokens != null && maxCtx != null && maxCtx > 0) ? `  ${Math.round(r.contextTokens / maxCtx * 100)}%` : "";
  const cost = r.costTotal ? `  $${r.costTotal.toFixed(4)}` : "";
  // #59/#60/#61 NIT: the journal fields v0.14.0 added to run:ended, now visible in the list.
  const err = r.error ? `  ✗"${r.error.length > 60 ? r.error.slice(0, 59) + "…" : r.error}"` : "";
  const tools = r.toolCallCount != null ? `  ·${r.toolCallCount}t` : "";
  const files = r.filesTouched?.length ? `  ✎${r.filesTouched.length}` : "";
  const summary = r.resultSummary ? `  "${r.resultSummary}"` : "";
  const prov = r.resumedFrom ? `  ← resumed:${r.resumedFrom}` : r.forkedFrom ? `  ← forked:${r.forkedFrom}` : "";
  const glyph = theme ? statusFg(r.status, theme, STATUS_GLYPH[r.status]) : STATUS_GLYPH[r.status];
  const status = theme ? statusFg(r.status, theme, r.status) : r.status;
  return `${glyph} ${r.runId}  ${r.agent}  ${status}  ${dur}${tok}${ctx}${cost}${tools}${files}${err}${summary}${prov}`;
}

export function runTimelineRow(e: MessageEvent | ToolEvent): string {
  const turn = Math.max(0, e.turnIndex);
  if (e.type === "message") {
    const text = e.text.length > 80 ? e.text.slice(0, 79) + "…" : e.text;
    const tok = e.usage?.total != null ? `  ${fmtTokens(e.usage.total)} tok` : "";
    return `[a] "${text}"${tok}  ·t${turn}`;
  }
  const glyph = e.isError ? "✗" : "✓";
  const err = e.isError ? `  "${e.result}"` : "";
  return `[t] ${e.toolName}  ${e.args}  ${glyph}${err}  ·t${turn}`;
}