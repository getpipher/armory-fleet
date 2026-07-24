// panel-spec2.test.mts — agentsRow armory chip + agentInfo detail pane content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsRow, agentInfo } from "../src/panel/rows.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const agent: AgentDef = {
  name: "reviewer", description: "reviews code", model: "anthropic/claude-sonnet-4",
  tools: ["read", "bash"], skills: ["tdd"], rolePrompt: "You are a reviewer.",
  todoSync: true, memoryHydrate: true, vision: false, backend: "pi", sessionKey: "reviewer", source: "project", filePath: "/x/reviewer.md",
};

test("agentsRow shows the armory chip [t✓ m✓ v✗]", () => {
  const row = agentsRow(agent);
  assert.match(row, /armory:\[t✓ m✓ v✗\]/);
});

test("agentInfo renders all armory hooks + model + skills + role prompt", () => {
  const info = agentInfo(agent);
  assert.match(info, /todoSync: ✓/);
  assert.match(info, /memoryHydrate: ✓/);
  assert.match(info, /vision: ✗/);
  assert.match(info, /model: anthropic\/claude-sonnet-4/);
  assert.match(info, /skills: tdd/);
  assert.match(info, /role prompt/);
  assert.match(info, /You are a reviewer\./);
});

test("agentInfo shows defaults when model/skills/thinkingLevel omitted", () => {
  const a: AgentDef = { ...agent, model: undefined, skills: undefined, thinkingLevel: undefined };
  const info = agentInfo(a);
  assert.match(info, /model: \(default\)/);
  assert.match(info, /skills: \(none\)/);
  assert.match(info, /thinkingLevel: \(model default\)/);
});