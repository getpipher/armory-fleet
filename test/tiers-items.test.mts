import { test } from "node:test";
import { strictEqual, ok, throws } from "node:assert";
import { buildTiersItems, setTierCostCap, setTierModels, setTierContextFloor, addTier, deleteTier } from "../src/panel/tiers-items.ts";
import { TierRegistry } from "../src/tiers/tier-registry.ts";
import type { Tier } from "../src/tiers/tier-registry.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";

const t = (over: Partial<Tier> = {}): Tier => ({ name: "standard", models: ["Ollama/glm-5.2:cloud"], ...over });
const tiers = (list: Tier[]) => new TierRegistry({ tiers: list, agents: new Map() });

test("buildTiersItems: one item per tier", () => {
  const reg = tiers([t({ name: "economy" }), t({ name: "standard" }), t({ name: "frontier" })]);
  const items = buildTiersItems({ tierRegistry: reg, runRegistry: new RunRegistry() });
  strictEqual(items.length, 3);
  strictEqual(items[0]!.value, "economy");
  strictEqual(items[1]!.value, "standard");
  strictEqual(items[2]!.value, "frontier");
});

test("buildTiersItems: spend = sum of run.costTotal for runs with matching tier", () => {
  const reg = tiers([t({ name: "standard" })]);
  const rr = new RunRegistry();
  rr.add({ runId: "r1", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "completed", startedAt: 1, tier: "standard", costTotal: 0.05 , cwd: "/", backend: "pi"});
  rr.add({ runId: "r2", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "completed", startedAt: 2, tier: "standard", costTotal: 0.03 , cwd: "/", backend: "pi"});
  rr.add({ runId: "r3", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "completed", startedAt: 3, tier: "frontier", costTotal: 0.5 , cwd: "/", backend: "pi"});
  const items = buildTiersItems({ tierRegistry: reg, runRegistry: rr });
  ok(items[0]!.label.includes("$0.0800"), `spend summed: ${items[0]!.label}`);
  ok(items[0]!.label.includes("2 runs"), `run count: ${items[0]!.label}`);
});

test("buildTiersItems: no-runs tier → $0.00 + 0 runs", () => {
  const reg = tiers([t({ name: "economy" })]);
  const items = buildTiersItems({ tierRegistry: reg, runRegistry: new RunRegistry() });
  ok(items[0]!.label.includes("$0.00"), `zero spend: ${items[0]!.label}`);
  ok(items[0]!.label.includes("0 runs"), `zero runs: ${items[0]!.label}`);
});

test("buildTiersItems: usedBy populated from agents map", () => {
  const reg = new TierRegistry({ tiers: [t({ name: "standard" })], agents: new Map([["coder", { tier: "standard" }]]) });
  const items = buildTiersItems({ tierRegistry: reg, runRegistry: new RunRegistry() });
  ok(items[0]!.label.includes("used by: coder"), `usedBy shown: ${items[0]!.label}`);
});

test("setTierCostCap: set cap to 1", () => {
  const result = setTierCostCap([t({ name: "x" })], "x", 1);
  strictEqual(result[0]!.costCap, 1);
});

test("setTierCostCap: undefined removes the field", () => {
  const result = setTierCostCap([t({ name: "x", costCap: 5 })], "x", undefined);
  strictEqual(result[0]!.costCap, undefined);
  ok(!("costCap" in result[0]!), "costCap field removed");
});

test("setTierCostCap: missing tier → throws", () => {
  throws(() => setTierCostCap([t({ name: "x" })], "y", 1), /tier 'y' not found/);
});

test("setTierModels: replaces models array", () => {
  const result = setTierModels([t({ name: "x", models: ["old"] })], "x", ["a", "b"]);
  strictEqual(result[0]!.models.length, 2);
  strictEqual(result[0]!.models[0], "a");
});

test("setTierModels: empty array → throws", () => {
  throws(() => setTierModels([t({ name: "x" })], "x", []), /models must be non-empty/);
});

test("setTierModels: missing tier → throws", () => {
  throws(() => setTierModels([t({ name: "x" })], "y", ["m"]), /tier 'y' not found/);
});

test("setTierContextFloor: set floor", () => {
  const result = setTierContextFloor([t({ name: "x" })], "x", 200000);
  strictEqual(result[0]!.contextFloor, 200000);
});

test("setTierContextFloor: undefined removes the field", () => {
  const result = setTierContextFloor([t({ name: "x", contextFloor: 200000 })], "x", undefined);
  ok(!("contextFloor" in result[0]!), "contextFloor field removed");
});

test("setTierContextFloor: missing tier → throws", () => {
  throws(() => setTierContextFloor([t({ name: "x" })], "y", 200000), /tier 'y' not found/);
});

test("addTier: creates a new tier", () => {
  const result = addTier([t({ name: "x" })], "y", ["model-y"]);
  strictEqual(result.length, 2);
  strictEqual(result[1]!.name, "y");
  strictEqual(result[1]!.models[0], "model-y");
});

test("addTier: duplicate name → throws", () => {
  throws(() => addTier([t({ name: "x" })], "x", ["m"]), /tier 'x' already exists/);
});

test("addTier: empty models → throws", () => {
  throws(() => addTier([t({ name: "x" })], "y", []), /models must be non-empty/);
});

test("deleteTier: removes the named tier", () => {
  const result = deleteTier([t({ name: "x" }), t({ name: "y" })], "x");
  strictEqual(result.length, 1);
  strictEqual(result[0]!.name, "y");
});

test("deleteTier: absent tier → no-op, no throw", () => {
  const result = deleteTier([t({ name: "x" })], "y");
  strictEqual(result.length, 1);
});