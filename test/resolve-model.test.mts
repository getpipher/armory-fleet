import { test } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { splitModel, resolveAgentModel, type ModelRegistryLike } from "../src/tiers/resolve.ts";
import { BUILTIN_TIERS } from "../src/tiers/builtin.ts";
import { TierRegistry } from "../src/tiers/tier-registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, userMemory: false,
  backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x", ...over,
});
const PARENT = { provider: "p", id: "m" };
const fakeReg = (windows: Record<string, number>): ModelRegistryLike => ({
  find: (provider, id) => { const w = windows[`${provider}/${id}`]; return w != null ? { contextWindow: w } : undefined; },
});
const tiers = (list: any[]) => new TierRegistry({ tiers: list, agents: new Map() });

test("splitModel: first-slash split; colon in id preserved", () => {
  deepStrictEqual(splitModel("Ollama/glm-5.2:cloud"), { provider: "Ollama", id: "glm-5.2:cloud" });
  deepStrictEqual(splitModel("anthropic/claude-sonnet-4"), { provider: "anthropic", id: "claude-sonnet-4" });
  deepStrictEqual(splitModel("bare-id", "Ollama"), { provider: "Ollama", id: "bare-id" });
});

test("resolveAgentModel: opts.model beats tier beats agent.model beats parent", () => {
  const reg = tiers([{ name: "t", models: ["Ollama/tm"] }]);
  const mr = fakeReg({ "Ollama/tm": 128000 });
  strictEqual(resolveAgentModel(agent({ tier: "t", model: "agent-model" }), "caller-model", PARENT, reg, mr).model, "caller-model");
  strictEqual(resolveAgentModel(agent({ tier: "t", model: "agent-model" }), undefined, PARENT, reg, mr).model, "Ollama/tm", "tier beats agent.model");
  strictEqual(resolveAgentModel(agent({ model: "agent-model" }), undefined, PARENT, reg, mr).model, "agent-model", "no tier → agent.model");
  strictEqual(resolveAgentModel(agent({}), undefined, PARENT, reg, mr).model, "p/m", "no tier, no model → parent");
});

test("resolveAgentModel: tier not found → error", () => {
  const res = resolveAgentModel(agent({ tier: "nope" }), undefined, PARENT, tiers([]), fakeReg({}));
  strictEqual((res as any).error, "tier 'nope' not found; available: ");
});

test("resolveAgentModel: contextFloor skips a too-small model, lands on next", () => {
  const reg = tiers([{ name: "big", models: ["Ollama/small", "Ollama/big"], contextFloor: 200000 }]);
  const mr = fakeReg({ "Ollama/small": 32000, "Ollama/big": 200000 });
  const res = resolveAgentModel(agent({ tier: "big" }), undefined, PARENT, reg, mr);
  strictEqual(res.model, "Ollama/big", "small skipped (below floor), big chosen");
  deepStrictEqual((res as any).candidates, ["Ollama/big"]);
});

test("resolveAgentModel: undefined contextWindow → treated as 0 → below any floor → skipped", () => {
  const reg = tiers([{ name: "big", models: ["Ollama/unknown", "Ollama/big"], contextFloor: 100000 }]);
  const mr = fakeReg({ "Ollama/big": 200000 }); // unknown not in catalog at all → find returns undefined → skip
  const res = resolveAgentModel(agent({ tier: "big" }), undefined, PARENT, reg, mr);
  strictEqual(res.model, "Ollama/big");
});

test("resolveAgentModel: all models below contextFloor → error", () => {
  const reg = tiers([{ name: "big", models: ["Ollama/a", "Ollama/b"], contextFloor: 500000 }]);
  const mr = fakeReg({ "Ollama/a": 128000, "Ollama/b": 200000 });
  const res = resolveAgentModel(agent({ tier: "big" }), undefined, PARENT, reg, mr);
  ok((res as any).error.includes("no eligible model"), (res as any).error);
  ok((res as any).error.includes("500000"), "error names the floor");
});
// ── #64: the "inherit" sentinel — provider-agnostic tiers ──

test("resolveAgentModel: 'inherit' resolves to the parent/active model with tier attached", () => {
  const reg = tiers([{ name: "t", models: ["inherit"] }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, PARENT, reg, fakeReg({}));
  strictEqual(res.model, "p/m", "inherit → parent provider/id");
  strictEqual(res.tier?.name, "t", "tier still attached (costCap/contextFloor metadata)");
  deepStrictEqual((res as any).candidates, ["p/m"]);
});

test("resolveAgentModel: 'inherit' works even when the parent model is NOT in the catalog", () => {
  // e.g. a claude-parented session — the parent string passes through without a catalog lookup
  const reg = tiers([{ name: "t", models: ["inherit"] }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, { provider: "claude", id: "sonnet" }, reg, fakeReg({}));
  strictEqual(res.model, "claude/sonnet");
});

test("resolveAgentModel: eligible concrete candidates win before the 'inherit' fallback", () => {
  const reg = tiers([{ name: "t", models: ["Ollama/big", "inherit"] }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, PARENT, reg, fakeReg({ "Ollama/big": 200000 }));
  strictEqual(res.model, "Ollama/big");
  deepStrictEqual((res as any).candidates, ["Ollama/big", "p/m"], "parent kept as a retry candidate");
});

test("resolveAgentModel: 'inherit' catches when concrete candidates are ineligible", () => {
  const reg = tiers([{ name: "t", models: ["Ollama/small", "inherit"], contextFloor: 200000 }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, PARENT, reg, fakeReg({ "Ollama/small": 32000 }));
  strictEqual(res.model, "p/m", "small below floor → inherit → parent");
});

test("resolveAgentModel: contextFloor is NOT enforced against the parent via 'inherit' (documented)", () => {
  // inherit = "use the active model" — the session model is presumed appropriate;
  // the floor guards concrete candidates only (issue #64 semantics).
  const reg = tiers([{ name: "t", models: ["inherit"], contextFloor: 500000 }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, { provider: "p", id: "small" }, reg, fakeReg({ "p/small": 8000 }));
  strictEqual(res.model, "p/small");
});

test("BUILTIN_TIERS are provider-agnostic (#64): all-inherit defaults, frontier keeps its floor", () => {
  for (const t of BUILTIN_TIERS) deepStrictEqual(t.models, ["inherit"], `${t.name}: models = ["inherit"]`);
  const frontier = BUILTIN_TIERS.find((t) => t.name === "frontier")!;
  ok(frontier, "frontier defined");
  strictEqual(frontier!.contextFloor, 200000);
  strictEqual(frontier!.costCap, undefined, "costCap dropped from the frontier default (no-op on flat subs; configure per-user)");
});

test("#64 review: empty parentModel → pure-inherit tier errors descriptively (no doomed '/' candidate)", () => {
  const reg = tiers([{ name: "t", models: ["inherit"] }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, { provider: "", id: "" }, reg, fakeReg({}));
  ok((res as any).error.includes("no eligible model"), (res as any).error);
});

test("#64 review: sentinel is case-insensitive + trimmed; concrete strings stay verbatim", () => {
  const reg = tiers([{ name: "t", models: ["  Inherit ", "Ollama/x"] }]);
  const res = resolveAgentModel(agent({ tier: "t" }), undefined, PARENT, reg, fakeReg({ "Ollama/x": 128000 }));
  strictEqual(res.model, "p/m", "normalized sentinel still resolves to the parent");
  const reg2 = tiers([{ name: "t2", models: ["Ollama/x", "Inherit"] }]);
  const res2 = resolveAgentModel(agent({ tier: "t2" }), undefined, PARENT, reg2, fakeReg({}));
  strictEqual(res2.model, "p/m", "mixed-case 'Inherit' still acts as the sentinel (exact-match would error 'no eligible model')");
});
