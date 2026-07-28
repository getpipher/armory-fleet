import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { gateGate, assertBudget } from "../src/lifecycle/gates/gate.ts";
import type { Tier } from "../src/tiers/tier-registry.ts";

const tier = (costCap?: number, contextFloor?: number): Tier => ({
  name: "std", models: ["Ollama/glm-5.2:cloud"], ...(costCap != null ? { costCap } : {}), ...(contextFloor != null ? { contextFloor } : {}),
});

test("assertBudget: under cap + under floor → passed", () => {
  const r = assertBudget({ lifecycleCost: 0.42, contextTokens: 27000, tier: tier(1.0, 200000) });
  ok(r.passed);
  ok(r.evidence.includes("0.42"));
});

test("assertBudget: cost over cap → failed", () => {
  const r = assertBudget({ lifecycleCost: 1.12, contextTokens: 27000, tier: tier(1.0, 200000) });
  strictEqual(r.passed, false);
  ok(r.evidence.includes("1.12"));
  ok(r.evidence.includes("1.00"));
});

test("assertBudget: context over floor → failed", () => {
  const r = assertBudget({ lifecycleCost: 0.1, contextTokens: 250000, tier: tier(1.0, 200000) });
  strictEqual(r.passed, false);
  ok(r.evidence.includes("250000"));
});

test("assertBudget: no tier → passed (skip — nothing to assert)", () => {
  const r = assertBudget({ lifecycleCost: 99, contextTokens: 999, tier: undefined });
  ok(r.passed, "no tier → no caps → skip (advise-pass)");
});

test("assertBudget: tier without caps → passed", () => {
  const r = assertBudget({ lifecycleCost: 99, contextTokens: 999, tier: tier() });
  ok(r.passed, "tier has no costCap/contextFloor → nothing to assert");
});

test("assertBudget: params.costCap overrides tier.costCap", () => {
  const r = assertBudget({ lifecycleCost: 1.5, contextTokens: 1000, tier: tier(1.0), params: { costCap: 2.0 } });
  ok(r.passed, "param cap 2.0 wins over tier cap 1.0");
});

test("gate: onFail abort, kind predicate", () => {
  strictEqual(gateGate.onFail, "abort");
  strictEqual(gateGate.kind, "predicate");
});

const ctx = (lifecycleCost: number, contextTokens: number, t?: Tier) => ({
  phaseRec: { name: "implement", summary: "", paths: [], status: "completed" as const, reviseCount: 0 },
  spawnRes: { status: "completed" as const, finalText: "", runId: "fl-x", todoId: null, agent: "a", model: "m", durationMs: 0, tokenTotal: 0 },
  lifecycle: { name: "default", task: "t", todoId: "todo1", backend: "pi" as const },
  tier: t, lifecycleCost, contextTokens, gateParams: undefined,
  spawn: async () => { throw new Error("not used"); },
  getModelContextWindow: () => undefined,
});

test("gate.run: over cap → failed + abort", async () => {
  const r = await gateGate.run(ctx(1.12, 27000, tier(1.0)));
  strictEqual(r.passed, false);
  strictEqual(r.onFail, "abort");
});