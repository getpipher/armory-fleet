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
import { layoutTree } from "../present/tree.ts";
import { GLYPHS } from "../present/glyphs.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

/** P2: minimal workflow projection for the fleet tree (WorkflowRunState is structurally
 *  compatible — only the fields the tree needs are carried). */
export interface FleetWorkflowRef {
  runId: string;
  name: string;
  status: string;
  startedAt: number;
  childRunIds: string[];
}

export interface FleetItemSources {
  runRegistry: { list(): RunRecord[] };
  bgRuns?: { values(): IterableIterator<BgRunStatus> };
  /** #104: when present, row glyph+status segments are theme-colored. */
  theme?: RowTheme;
  /** P2: workflow runs (newest-first from WorkflowRunStore.values()) supplying childRunIds parents. */
  workflowRuns?: FleetWorkflowRef[];
  /** P2: group runs under their spawning workflow (synthesized `wf:<id>` parent rows). */
  tree?: boolean;
}

export function buildFleetItems(src: FleetItemSources): SelectItem[] {
  const registryRows = src.runRegistry.list();
  const bgRows = src.bgRuns ? [...src.bgRuns.values()] : [];
  if (!src.tree || !src.workflowRuns?.length) {
    // Flat path — byte-identical to the pre-tree behavior.
    const items: SelectItem[] = [];
    const seen = new Set<string>();
    for (const r of registryRows) {
      if (seen.has(r.runId)) continue;
      seen.add(r.runId);
      items.push({ value: r.runId, label: fleetRow(r, undefined, src.theme) });
    }
    for (const b of bgRows) {
      if (seen.has(b.runId)) continue;
      seen.add(b.runId);
      items.push({ value: b.runId, label: renderBgRow(b, src.theme) });
    }
    return items;
  }
  // Tree path: join runs against workflow childRunIds (newest-first; first match wins).
  // Claims intersect the VISIBLE ids — a workflow whose children are all absent
  // (e.g. a persisted entry from a previous session) renders no row at all.
  const visible = new Set([...registryRows.map((r) => r.runId), ...bgRows.map((b) => b.runId)]);
  const parentOf = new Map<string, FleetWorkflowRef>();
  const visibleClaims = new Map<string, number>();
  for (const w of src.workflowRuns) {
    for (const c of w.childRunIds) {
      if (!visible.has(c) || parentOf.has(c)) continue; // first match wins; only visible ids claim
      parentOf.set(c, w);
      visibleClaims.set(w.runId, (visibleClaims.get(w.runId) ?? 0) + 1);
    }
  }
  const owner = new Set([...parentOf.values()].map((w) => w.runId));
  interface Node { key: string; at: number; label: string; parent: string | null }
  const nodes: Node[] = [];
  const seen = new Set<string>();
  const push = (key: string, at: number, label: string, parent: string | null): void => {
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push({ key, at, label, parent });
  };
  for (const r of registryRows) push(r.runId, r.startedAt, fleetRow(r, undefined, src.theme), parentOf.has(r.runId) ? `wf:${parentOf.get(r.runId)!.runId}` : null);
  // BgRunStatus carries elapsedMs (not startedAt) — negated, ascending sort puts bg roots
  // before epoch-based fg roots; among bg, longer-running first.
  for (const b of bgRows) push(b.runId, -(b.elapsedMs ?? 0), renderBgRow(b, src.theme), parentOf.has(b.runId) ? `wf:${parentOf.get(b.runId)!.runId}` : null);
  for (const w of src.workflowRuns) {
    if (!owner.has(w.runId)) continue; // only workflows that own ≥1 visible child
    const glyph = (GLYPHS.status as Record<string, string>)[w.status] ?? GLYPHS.status.queued;
    push(`wf:${w.runId}`, w.startedAt, `${glyph} wf:${w.runId}  ${w.name}  ·${visibleClaims.get(w.runId) ?? 0} runs`, null);
  }
  return layoutTree(nodes, (nd) => nd.key, (nd) => nd.parent, (nd) => nd.at)
    .map(({ row, prefix }) => ({ value: row.key, label: prefix + row.label }));
}