import type { Tier } from "../tiers/tier-registry.ts";

function fmtFloor(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** One row per tier for the /fleet Tiers view. Pure (unit-tested). */
export function renderTierRow(tier: Tier, spend: number, usedBy: string[], runCount: number): string {
  const cap = tier.costCap != null ? `$${tier.costCap}` : "—";
  const floor = fmtFloor(tier.contextFloor);
  const spendStr = spend > 0 ? `$${spend.toFixed(4)}` : "$0.00";
  const used = usedBy.length ? `used by: ${usedBy.join(", ")}` : "used by: —";
  return `${tier.name}  ${tier.models.join("→")}  ${cap}  ${floor}  ${spendStr}  ${runCount} runs  ${used}`;
}