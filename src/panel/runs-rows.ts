// src/panel/runs-rows.ts
// SPEC-5b-1 — pure renderers for the Runs tab + per-turn timeline. Reuses the glyph
// language (▶ ✓ ✗) so the Runs tab is visually consistent with Fleet/Lifecycle.
import { fmtDuration, fmtTokens } from "./rows.ts";
import type { RunMeta, MessageEvent, ToolEvent } from "../runtime/run-log.ts";

const STATUS_GLYPH: Record<RunMeta["status"], string> = {
  running: "▶", completed: "✓", failed: "✗", aborted: "✗",
};

export function runsRow(r: RunMeta, getModelContextWindow?: (model: string) => number | undefined): string {
  const dur = r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "—";
  const tok = r.tokenTotal > 0 ? `  ${fmtTokens(r.tokenTotal)} tok` : "";
  const maxCtx = getModelContextWindow?.(r.model);
  const ctx = (r.contextTokens != null && maxCtx != null && maxCtx > 0) ? `  ${Math.round(r.contextTokens / maxCtx * 100)}%` : "";
  const cost = r.costTotal ? `  $${r.costTotal.toFixed(4)}` : "";
  const summary = r.resultSummary ? `  "${r.resultSummary}"` : "";
  const prov = r.resumedFrom ? `  ← resumed:${r.resumedFrom}` : r.forkedFrom ? `  ← forked:${r.forkedFrom}` : "";
  return `${STATUS_GLYPH[r.status]} ${r.runId}  ${r.agent}  ${r.status}  ${dur}${tok}${ctx}${cost}${summary}${prov}`;
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