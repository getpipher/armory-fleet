import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { TierRegistry, parseTiersFile, mergeTiers, type Tier } from "../src/tiers/tier-registry.ts";
import { BUILTIN_TIERS } from "../src/tiers/builtin.ts";

const good = (n: string, models: string[] = [`${n}-model`]): Tier => ({ name: n, models });

test("parseTiersFile: valid array of tiers", () => {
  deepStrictEqual(parseTiersFile(`[{ "name": "x", "models": ["m1"] }]`), [{ name: "x", models: ["m1"] }]);
});

test("parseTiersFile: empty input → empty array", () => {
  deepStrictEqual(parseTiersFile(""), []);
  deepStrictEqual(parseTiersFile("[]"), []);
});

test("parseTiersFile: malformed JSON → throws", () => {
  throws(() => parseTiersFile("{ not json"), /malformed tiers file/);
});

test("parseTiersFile: duplicate name → throws", () => {
  throws(() => parseTiersFile(`[{ "name": "x", "models": ["m"] }, { "name": "x", "models": ["m2"] }]`), /duplicate tier name/);
});

test("parseTiersFile: missing name/models → throws", () => {
  throws(() => parseTiersFile(`[{ "models": ["m"] }]`), /tier missing name/);
  throws(() => parseTiersFile(`[{ "name": "x" }]`), /tier missing models/);
  throws(() => parseTiersFile(`[{ "name": "x", "models": [] }]`), /tier 'x' has empty models/);
});

test("mergeTiers: builtins < global < project (project wins by name)", () => {
  const merged = mergeTiers(
    [good("economy"), good("standard")],
    [good("standard", ["global-std"]), good("custom")],
    [good("standard", ["proj-std"]), good("local")],
  );
  const byName = new Map(merged.map((t) => [t.name, t]));
  strictEqual(byName.get("economy")!.models[0], "economy-model", "builtin economy kept");
  strictEqual(byName.get("standard")!.models[0], "proj-std", "project wins over global + builtin");
  strictEqual(byName.get("custom")!.models[0], "custom-model", "global-only tier kept");
  strictEqual(byName.get("local")!.models[0], "local-model", "project-only tier kept");
});

test("TierRegistry.get/list/usedBy", () => {
  const reg = new TierRegistry({
    tiers: mergeTiers(BUILTIN_TIERS, [], []),
    agents: new Map([["coder", { tier: "standard" } as any], ["oracle", { tier: "frontier" } as any]]),
  });
  strictEqual(reg.get("economy")!.models[0], "inherit");
  strictEqual(reg.get("frontier")!.costCap, undefined);
  strictEqual(reg.get("frontier")!.contextFloor, 200000);
  deepStrictEqual(reg.list().map((t) => t.name), ["economy", "standard", "frontier"]);
  deepStrictEqual(reg.usedBy("standard"), ["coder"]);
  deepStrictEqual(reg.usedBy("frontier"), ["oracle"]);
  deepStrictEqual(reg.usedBy("economy"), []);
  strictEqual(reg.get("nope"), undefined, "missing tier → undefined");
});