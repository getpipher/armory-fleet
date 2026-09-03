// src/transcript/findings.ts — pure findings-block builders (#104): burst-end rows + render lines.
// No I/O, no Date.now(); durations come from RunCardState.endedAt (replay-safe).
import { GLYPHS } from "../present/glyphs.ts";
import { fmtDur, fmtTok } from "./run-card.ts";
import type { RunCardState } from "./card-state.ts";

export interface FindingRow {
  status: string; agent: string; dur?: string; tok?: string; cost?: string;
  note?: string; warn?: boolean;
}

/** Render lines for the fleet-findings entry. Missing numbers render as `—` (honesty). */
export function findingLines(rows: FindingRow[]): string[] {
  const out = ["── findings ────────────────────────────────"];
  for (const r of rows) {
    const g = (GLYPHS.status as Record<string, string>)[r.status] ?? GLYPHS.status.queued;
    const cells = [r.dur ?? "—", r.tok ?? "—", r.cost ?? "—"].join("  ");
    out.push(`${g} ${r.agent.padEnd(12)} ${cells}  ${r.note ?? ""}${r.warn ? ` ${GLYPHS.gateWarn}` : ""}`.trimEnd());
  }
  return out;
}

/** Map the burst's final run snapshots to FindingRow[]. Terminal rows only; failed/aborted
 *  rows carry no numbers (dur/tok/cost undefined → `—` in findingLines) per the honesty rule. */
export function findingsFromRuns(runs: RunCardState[]): FindingRow[] {
  return runs
    .filter((r) => r.status === "completed" || r.status === "failed" || r.status === "aborted")
    .map((r) => {
      if (r.status === "completed") {
        return {
          status: r.status,
          agent: r.agent,
          dur: r.endedAt != null ? fmtDur(r.endedAt - r.startedAt) : undefined,
          tok: fmtTok(r.contextTokens),
          cost: r.costTotal != null ? `$${r.costTotal.toFixed(2)}` : undefined,
          note: r.resultSummary,
          warn: (r.warnings?.length ?? 0) > 0,
        };
      }
      return { status: r.status, agent: r.agent, note: r.error ?? r.status, warn: true };
    });
}
