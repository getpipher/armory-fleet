import type { Tier } from "../tiers/tier-registry.ts";
import type { TierRegistry } from "../tiers/tier-registry.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import { renderTierRow } from "./tiers-rows.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

export interface TiersItemSources {
  tierRegistry: TierRegistry;
  runRegistry: RunRegistry;
}

/** Build the /fleet Tiers view list items. One per tier, labeled via `renderTierRow`. */
export function buildTiersItems(src: TiersItemSources): SelectItem[] {
  const runs = src.runRegistry.list();
  return src.tierRegistry.list().map((tier) => {
    const tierRuns = runs.filter((r) => r.tier === tier.name);
    const spend = tierRuns.reduce((sum, r) => sum + (r.costTotal ?? 0), 0);
    const runCount = tierRuns.length;
    const usedBy = src.tierRegistry.usedBy(tier.name);
    return { value: tier.name, label: renderTierRow(tier, spend, usedBy, runCount) };
  });
}

/** Set the costCap on a tier. `undefined` removes the field. Throws if tier not found. */
export function setTierCostCap(tiers: Tier[], name: string, cap: number | undefined): Tier[] {
  const idx = tiers.findIndex((t) => t.name === name);
  if (idx < 0) throw new Error(`tier '${name}' not found`);
  const updated = { ...tiers[idx]! };
  if (cap != null) updated.costCap = cap;
  else delete updated.costCap;
  return [...tiers.slice(0, idx), updated, ...tiers.slice(idx + 1)];
}

/** Replace the models array on a tier. Empty array → throws. Throws if tier not found. */
export function setTierModels(tiers: Tier[], name: string, models: string[]): Tier[] {
  if (models.length === 0) throw new Error(`tier '${name}': models must be non-empty`);
  const idx = tiers.findIndex((t) => t.name === name);
  if (idx < 0) throw new Error(`tier '${name}' not found`);
  const updated = { ...tiers[idx]!, models };
  return [...tiers.slice(0, idx), updated, ...tiers.slice(idx + 1)];
}

/** Set/unset the contextFloor on a tier. Throws if tier not found. */
export function setTierContextFloor(tiers: Tier[], name: string, floor: number | undefined): Tier[] {
  const idx = tiers.findIndex((t) => t.name === name);
  if (idx < 0) throw new Error(`tier '${name}' not found`);
  const updated = { ...tiers[idx]! };
  if (floor != null) updated.contextFloor = floor;
  else delete updated.contextFloor;
  return [...tiers.slice(0, idx), updated, ...tiers.slice(idx + 1)];
}

/** Add a new tier. Throws on duplicate name or empty models. */
export function addTier(tiers: Tier[], name: string, models: string[]): Tier[] {
  if (models.length === 0) throw new Error(`tier '${name}': models must be non-empty`);
  if (tiers.some((t) => t.name === name)) throw new Error(`tier '${name}' already exists`);
  return [...tiers, { name, models }];
}

/** Remove a tier by name. No-op if absent (no throw). */
export function deleteTier(tiers: Tier[], name: string): Tier[] {
  return tiers.filter((t) => t.name !== name);
}