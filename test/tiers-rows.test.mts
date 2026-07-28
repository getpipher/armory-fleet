import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { renderTierRow } from "../src/panel/tiers-rows.ts";
import type { Tier } from "../src/tiers/tier-registry.ts";

const t = (over: Partial<Tier> = {}): Tier => ({ name: "standard", models: ["Ollama/glm-5.2:cloud", "Ollama/minimax-m3:cloud"], ...over });

test("renderTierRow: models chain arrow, spend, used-by", () => {
  const row = renderTierRow(t(), 0.12, ["coder", "scout"], 3);
  ok(row.includes("standard"), "name");
  ok(row.includes("Ollama/glm-5.2:cloud→Ollama/minimax-m3:cloud"), "models chain: " + row);
  ok(row.includes("$0.12"), "spend");
  ok(row.includes("3 runs"), "run count");
  ok(row.includes("used by: coder, scout"), "used-by list");
});

test("renderTierRow: costCap + contextFloor shown; — when absent", () => {
  ok(renderTierRow(t({ costCap: 5, contextFloor: 200000 }), 0, [], 0).includes("$5"), "cap shown");
  ok(renderTierRow(t({ costCap: 5, contextFloor: 200000 }), 0, [], 0).includes("200k"), "floor shown");
  ok(renderTierRow(t(), 0, [], 0).includes("—"), "— when cap/floor absent");
});