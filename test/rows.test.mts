// test/rows.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { fleetRow, agentsRow, fmtDuration } from "../src/panel/rows.ts";
import type { RunRecord } from "../src/engine/run-registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "fl-3kf9a2", agent: "general-purpose", model: "m", task: "review auth module",
  track: true, todoId: "td-mrubw7", status: "running", startedAt: 1, ...over,
});

test("fmtDuration: seconds", () => { strictEqual(fmtDuration(18000), "18s"); });
test("fmtDuration: 45s", () => { strictEqual(fmtDuration(45000), "45s"); });
test("fmtDuration: minutes", () => { strictEqual(fmtDuration(90000), "1m30s"); });

test("fleetRow status glyphs", () => {
  ok(fleetRow(run()).startsWith("▶"), "running uses ▶");
  ok(fleetRow(run({ status: "completed" })).startsWith("✓"));
  ok(fleetRow(run({ status: "aborted" })).startsWith("✗"));
  ok(fleetRow(run({ status: "failed" })).startsWith("✗"));
});

test("fleetRow includes runId, agent, status, todoId, summary", () => {
  const r = fleetRow(run({ status: "completed", endedAt: 2, resultSummary: "refactored X" }));
  ok(r.includes("fl-3kf9a2"), r);
  ok(r.includes("general-purpose"), r);
  ok(r.includes("completed"), r);
  ok(r.includes("td-mrubw7"), r);
  ok(r.includes("refactored X"), r);
});

test("fleetRow ctxPercent", () => {
  ok(fleetRow(run(), 32).includes("32% ctx"));
  ok(!fleetRow(run()).includes("ctx"));
});

test("agentsRow includes name, source, model, armory chip", () => {
  const a: AgentDef = { name: "scout", description: "d", model: "anthropic/claude-sonnet-4", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: "scout", source: "project", filePath: "/x" };
  const r = agentsRow(a);
  ok(r.includes("scout"), r);
  ok(r.includes("[project]"), r);
  ok(r.includes("anthropic/claude-sonnet-4"), r);
  ok(r.includes("armory:[t✓ m✓ v✓]"), r);
});

test("agentsRow default model + tools/skills omitted", () => {
  const a: AgentDef = { name: "g", description: "d", rolePrompt: "r", todoSync: false, memoryHydrate: false, vision: false, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x" };
  const r = agentsRow(a);
  ok(r.includes("(default)"), r);
  ok(r.includes("armory:[t✗ m✗ v✗]"), r);
  ok(!r.includes("tools:"), r);
  ok(!r.includes("skills:"), r);
});