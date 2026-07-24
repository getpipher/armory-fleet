import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";

const fakeFactory: ChildSessionFactory = { async create() { throw new Error("unused"); } };

test("hook parity constants are declared", () => {
  strictEqual(PI_HOOK_PARITY.todo, "✓");
  strictEqual(PI_HOOK_PARITY.memory, "✓");
  strictEqual(PI_HOOK_PARITY.vision, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.todo, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.memory, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.vision, "~");
});

test("BackendRegistry register/get/list", () => {
  const reg = new BackendRegistry();
  const pi: Backend = { id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(pi);
  ok(reg.get("pi") === pi);
  strictEqual(reg.list().length, 1);
  strictEqual(reg.get("nope"), undefined);
});

test("BackendRegistry list reflects registration order", () => {
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  reg.register({ id: "claude", factory: fakeFactory, available: () => false, versionInfo: () => ({ version: "1.0.0", schemaOk: false, flagSupport: {}, note: "not installed" }), hookParity: CLAUDE_HOOK_PARITY });
  const ids = reg.list().map((b) => b.id);
  ok(ids[0] === "pi" && ids[1] === "claude");
});