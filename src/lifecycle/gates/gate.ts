import type { GateDef, GateCtx, GateResult } from "./registry.ts";
import type { Tier } from "../../tiers/tier-registry.ts";

export interface BudgetInput {
  lifecycleCost: number;
  contextTokens: number;
  tier?: Tier;
  params?: Record<string, unknown>;
}
export interface BudgetResult { passed: boolean; evidence: string; }

/** Pure: assert cost < cap and context < floor. Missing tier/caps → skip (pass). */
export function assertBudget(input: BudgetInput): BudgetResult {
  const { lifecycleCost, contextTokens, tier, params } = input;
  if (!tier) return { passed: true, evidence: "no tier → no caps to assert (skip)" };
  const costCap = typeof (params as { costCap?: number } | undefined)?.costCap === "number"
    ? (params as { costCap: number }).costCap : tier.costCap;
  const contextFloor = typeof (params as { contextFloor?: number } | undefined)?.contextFloor === "number"
    ? (params as { contextFloor: number }).contextFloor : tier.contextFloor;
  const parts: string[] = [];
  if (typeof costCap === "number") {
    if (lifecycleCost > costCap) return { passed: false, evidence: `cost $${lifecycleCost.toFixed(2)} > cap $${costCap.toFixed(2)}` };
    parts.push(`cost $${lifecycleCost.toFixed(2)} < cap $${costCap.toFixed(2)}`);
  }
  if (typeof contextFloor === "number") {
    if (contextTokens > contextFloor) return { passed: false, evidence: `context ${contextTokens} > floor ${contextFloor}` };
    parts.push(`ctx ${contextTokens} < floor ${contextFloor}`);
  }
  if (parts.length === 0) return { passed: true, evidence: "tier has no costCap/contextFloor → nothing to assert" };
  return { passed: true, evidence: parts.join("; ") };
}

export const gateGate: GateDef = {
  name: "gate",
  kind: "predicate",
  onFail: "abort",
  run: async (ctx: GateCtx): Promise<GateResult> => {
    const r = assertBudget({ lifecycleCost: ctx.lifecycleCost, contextTokens: ctx.contextTokens, tier: ctx.tier, params: ctx.gateParams });
    return { gate: "gate", kind: "predicate", passed: r.passed, evidence: r.evidence, onFail: "abort" };
  },
};