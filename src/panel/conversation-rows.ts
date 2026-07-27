// src/panel/conversation-rows.ts
// SPEC-5b-3 — pure renderers for the full-message overlay (second level over the 5b-1 timeline).
// Plain strings, no theme (codebase convention: theming is applied at the SelectList callback layer).
//
// Journal fidelity (Q2=C): MessageEvent.text is already the FULL assistant text (5b-1 Q1). Tool
// args/result are the journaled excerpt (5b-1: args≤200ch, result≤500ch, errors in-full). The
// toolHeader notes "args/result excerpted" so the asymmetry is honest.
import type { MessageEvent, ToolEvent } from "../runtime/run-log.ts";

/** Word-wrap `text` to `width` columns. Long tokens (no break opportunity) hard-split at `width`.
 *  Explicit `\n` is preserved as a row break (multi-line tool results). Empty → [""]; width≤0 → [""].
 *  Operates on the string by `.length` (UTF-16 code units) — sufficient for the overlay's purposes;
 *  CJK chars count as 1 col each in most terminals, matching the test expectations. */
export function wrapToLines(text: string, width: number): string[] {
  if (width <= 0) return [""];
  if (text.length === 0) return [""];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) { out.push(""); continue; }
    const words = para.split(" ");
    let line = "";
    for (const w of words) {
      if (w.length === 0) continue; // collapse runs of spaces
      if (line.length === 0) {
        // long token with no break opportunity: hard-split at width
        let rest = w;
        while (rest.length > width) {
          out.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        line = rest;
      } else if (line.length + 1 + w.length <= width) {
        line += " " + w;
      } else {
        out.push(line);
        let rest = w;
        while (rest.length > width) {
          out.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

/** Body for an assistant message: the full text, wrapped. */
export function messageBody(e: MessageEvent, width: number): string[] {
  return wrapToLines(e.text, width);
}

/** Body for a tool event: `args:` + indented args, `result:` + indented result. */
export function toolBody(e: ToolEvent, width: number): string[] {
  const inner = Math.max(2, width - 2);
  const lines: string[] = ["args:"];
  for (const l of wrapToLines(e.args, inner)) lines.push("  " + l);
  lines.push("result:");
  for (const l of wrapToLines(e.result, inner)) lines.push("  " + l);
  return lines;
}

/** Header for an assistant message event. Omits the token segment when usage.total is absent. */
export function messageHeader(e: MessageEvent): string {
  const turn = Math.max(0, e.turnIndex);
  const tok = e.usage?.total != null ? ` · ${e.usage.total} tok` : "";
  return `── assistant · turn ${turn}${tok} ──`;
}

/** Header for a tool event. Notes "args/result excerpted" (Q2=C honest asymmetry). */
export function toolHeader(e: ToolEvent): string {
  const turn = Math.max(0, e.turnIndex);
  const glyph = e.isError ? "✗" : "✓";
  return `── tool: ${e.toolName} · turn ${turn} · ${glyph} · args/result excerpted ──`;
}