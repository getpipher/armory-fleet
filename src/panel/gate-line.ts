import type { GateResult } from "../lifecycle/gates/registry.ts";
import { GLYPHS } from "../present/glyphs.ts";

// #104 emoji purge: gate glyphs come from the single vocabulary (pass/abort → ✓/✗; ↻/⚠ stay).
export function gateGlyph(r: GateResult): string {
  if (r.passed) return GLYPHS.gatePass;
  if (r.onFail === "abort") return GLYPHS.gateFail;
  if (r.onFail === "revise") return GLYPHS.gateRevise;
  return GLYPHS.gateWarn; // advise
}

/** Pure: build the compact gate line for a Lifecycle view phase row. */
export function buildGateLine(results: GateResult[]): string {
  if (results.length === 0) return "";
  const parts = results.map((r) => `${gateGlyph(r)}${r.gate}`);
  // If the last failing gate short-circuited, append the action.
  const lastFail = [...results].reverse().find((r) => !r.passed);
  let suffix = "";
  if (lastFail) {
    if (lastFail.onFail === "abort") suffix = " → aborted";
    else if (lastFail.onFail === "revise") suffix = " → revising";
  }
  return `gates: ${parts.join("  ")}${suffix}`;
}
