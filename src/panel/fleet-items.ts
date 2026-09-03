// src/panel/fleet-items.ts
// SPEC-5a proper-fix: pure builder for the /fleet fleet-tab list items.
//
// Extracted from FleetPanel.buildList so the merge + dedup of foreground
// (RunRegistry) rows and live bg (BgRunsStore) rows is unit-testable without
// a TUI harness. Foreground rows render via `fleetRow`; bg rows via
// `renderBgRow` (the Q8=A live status icons + phase progress). The two stores
// are disjoint by runId in practice (bg runs never enter RunRegistry under
// their own runId; the lifecycle's child spawns use their own runIds), but we
// dedup defensively in case a future change overlaps them.
import type { RunRecord } from "../engine/run-registry.ts";
import { fleetRow, renderBgRow, type BgRunStatus, type RowTheme } from "./rows.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

export interface FleetItemSources {
  runRegistry: { list(): RunRecord[] };
  bgRuns?: { values(): IterableIterator<BgRunStatus> };
  /** #104: when present, row glyph+status segments are theme-colored. */
  theme?: RowTheme;
}

export function buildFleetItems(src: FleetItemSources): SelectItem[] {
  const items: SelectItem[] = [];
  const seen = new Set<string>();
  for (const r of src.runRegistry.list()) {
    if (seen.has(r.runId)) continue;
    seen.add(r.runId);
    items.push({ value: r.runId, label: fleetRow(r, undefined, src.theme) });
  }
  if (src.bgRuns) {
    for (const b of src.bgRuns.values()) {
      if (seen.has(b.runId)) continue;
      seen.add(b.runId);
      items.push({ value: b.runId, label: renderBgRow(b, src.theme) });
    }
  }
  return items;
}