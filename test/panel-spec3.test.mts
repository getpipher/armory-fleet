import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { backendsRow, backendInfo, agentsRow } from "../src/panel/rows.ts";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const fakeFactory: ChildSessionFactory = { async create() { throw new Error("x"); } };

const piBe: Backend = { id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => ({ version: "0.81.1", schemaOk: true, flagSupport: {} }), hookParity: PI_HOOK_PARITY };
const ccBe: Backend = { id: "claude", factory: fakeFactory, available: () => false, versionInfo: () => ({ version: "1.0.0", schemaOk: false, flagSupport: {}, note: "not installed" }), hookParity: CLAUDE_HOOK_PARITY };

test("backendsRow shows id, available glyph, version, schema, chip", () => {
  const r = backendsRow(piBe);
  ok(r.includes("pi"));
  ok(r.includes("✓"));          // available
  ok(r.includes("0.81.1"));
  ok(r.includes("t✓ m✓ v✓"));
});

test("backendsRow shows ✗ + note when unavailable", () => {
  const r = backendsRow(ccBe);
  ok(r.includes("✗"));
  ok(r.includes("not installed"));
  ok(r.includes("t✓ m✓ v~"));
});

test("backendInfo enumerates fields + hook mechanism notes", () => {
  const info = backendInfo(ccBe);
  ok(info.includes("id: claude"));
  ok(info.includes("schemaOk: false"));
  ok(info.includes("vision: ~"));
  ok(info.includes("pass-through only"));
});

test("agentsRow includes the backend badge", () => {
  const a: AgentDef = { name: "g", description: "d", model: "m", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, backend: "claude", sessionKey: "g", source: "builtin", filePath: "/x" };
  const r = agentsRow(a);
  ok(r.includes("[claude]"));
  ok(r.includes("t✓ m✓ v✓"));   // chip still reflects agent toggles (per-hook), backend parity is separate
});