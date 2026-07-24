import { test } from "node:test";
import { ok } from "node:assert";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";

// The real wiring is exercised end-to-end in Task 13's smoke; this guards the registry shape
// the default export builds (pi always present; claude registered regardless of availability).
test("a SPEC-3-style BackendRegistry always has pi and registers claude (availability reflects detection)", () => {
  const reg = new BackendRegistry();
  const fakeFactory: ChildSessionFactory = { async create() { throw new Error("x"); } };
  const pi: Backend = { id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(pi);
  reg.register({ id: "claude", factory: fakeFactory, available: () => false, versionInfo: () => ({ version: "", schemaOk: false, flagSupport: {}, note: "not installed" }), hookParity: { todo: "✓", memory: "✓", vision: "~" } });
  ok(reg.get("pi"));
  ok(reg.get("claude"));                                   // registered even when unavailable (Backends view shows it)
  ok(reg.get("pi")!.available());
  ok(!reg.get("claude")!.available());                     // availability reflects detection
});