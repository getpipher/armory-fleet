import { test } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { splitModel, resolveAgentModel, type ModelRegistryLike } from "../src/tiers/resolve.ts";
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