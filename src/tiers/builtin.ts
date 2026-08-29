import type { Tier } from "./tier-registry.ts";

/**
 * Shipped default tiers (Q10). Overridable via global/project tiers.json.
 *
 * Provider-agnostic since #64: the `inherit` sentinel resolves to the parent/active
 * session model, so zero-config fleets work on ANY provider. Users who want real
 * multi-model cost routing override these by name with concrete `provider/id`
 * chains (`inherit` may also appear mid-chain as a fallback). `contextFloor`
 * guards concrete candidates; `costCap` is a per-run $ abort (configure where
 * meaningful — it is a no-op on flat subscriptions).
 */
export const BUILTIN_TIERS: Tier[] = [
  { name: "economy",  models: ["inherit"] },
  { name: "standard", models: ["inherit"] },
  { name: "frontier", models: ["inherit"], contextFloor: 200000 },
];
