import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { GateRegistry, resolveGates, type GateDef, type GateRef, type GateResult } from "../src/lifecycle/gates/registry.ts";

const fakeGate = (name: string, kind: "agent" | "predicate" = "predicate", onFail: "advise" | "revise" | "abort" = "advise"): GateDef => ({
  name, kind, onFail,
  run: async () => ({ gate: name, kind, passed: true, evidence: "", onFail }),
});

test("GateRegistry register/get/list", () => {
  const reg = new GateRegistry();
  reg.register(fakeGate("verify", "agent", "advise"));
  reg.register(fakeGate("completenessCheck"));
  strictEqual(reg.get("verify")!.kind, "agent");
  strictEqual(reg.get("nope"), undefined);
  deepStrictEqual(reg.list().map((g) => g.name), ["verify", "completenessCheck"]);
});

test("GateRegistry.register: duplicate name throws", () => {
  const reg = new GateRegistry();
  reg.register(fakeGate("verify"));
  throws(() => reg.register(fakeGate("verify")), /duplicate gate name 'verify'/);
});

test("resolveGates: string ref → registry defaults", () => {
  const reg = new GateRegistry();
  reg.register(fakeGate("verify", "agent", "advise"));
  const resolved = resolveGates(["verify"], reg);
  strictEqual(resolved.length, 1);
  strictEqual(resolved[0]!.name, "verify");
  strictEqual(resolved[0]!.onFail, "advise", "onFail from registry default");
});

test("resolveGates: object ref overrides onFail + params", () => {
  const reg = new GateRegistry();
  reg.register(fakeGate("gate", "predicate", "abort"));
  const resolved = resolveGates([{ name: "gate", onFail: "revise", params: { costCap: 2 } }], reg);
  strictEqual(resolved[0]!.onFail, "revise", "phase override wins");
  deepStrictEqual(resolved[0]!.params, { costCap: 2 });
});

test("resolveGates: unknown gate name throws", () => {
  const reg = new GateRegistry();
  throws(() => resolveGates(["nope"], reg), /unknown gate 'nope'/);
});

test("resolveGates: empty refs → empty array", () => {
  const reg = new GateRegistry();
  deepStrictEqual(resolveGates([], reg), []);
});

test("GateResult shape: agent gate carries cost + runId", () => {
  const r: GateResult = { gate: "verify", kind: "agent", passed: true, evidence: "ok", onFail: "advise", cost: 0.42, runId: "fl-x" };
  strictEqual(r.cost, 0.42);
  strictEqual(r.runId, "fl-x");
});