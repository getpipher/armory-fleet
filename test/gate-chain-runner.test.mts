import { test } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { runGateChain } from "../src/lifecycle/gates/chain-runner.ts";
import type { GateDef, GateResult, GateCtx } from "../src/lifecycle/gates/registry.ts";

const passGate = (name: string): GateDef => ({
  name, kind: "predicate", onFail: "advise",
  run: async () => ({ gate: name, kind: "predicate", passed: true, evidence: "ok", onFail: "advise" }),
});
const failGate = (name: string, onFail: "advise" | "revise" | "abort"): GateDef => ({
  name, kind: "predicate", onFail,
  run: async () => ({ gate: name, kind: "predicate", passed: false, evidence: `${name} failed`, onFail }),
});

const ctx = (): GateCtx => ({
  phaseRec: { name: "implement", summary: "", paths: [], status: "completed" as const, reviseCount: 0 },
  spawnRes: { status: "completed" as const, finalText: "", runId: "fl-x", todoId: null, agent: "a", model: "m", durationMs: 0, tokenTotal: 0 },
  lifecycle: { name: "default", task: "t", todoId: "todo1", backend: "pi" as const },
  lifecycleCost: 0, contextTokens: 0, gateParams: undefined,
  spawn: async () => { throw new Error("not used"); },
  getModelContextWindow: () => undefined,
});

test("all gates pass → results returned, no short-circuit", async () => {
  const r = await runGateChain({ gates: [passGate("a"), passGate("b")], ctx: ctx() });
  strictEqual(r.shortCircuit, undefined);
  strictEqual(r.results.length, 2);
  ok(r.results.every((x) => x.passed));
});

test("advise failure → continues chain, collects evidence, no short-circuit", async () => {
  const r = await runGateChain({ gates: [passGate("a"), failGate("v", "advise"), passGate("b")], ctx: ctx() });
  strictEqual(r.shortCircuit, undefined);
  strictEqual(r.results.length, 3);
  strictEqual(r.results[1]!.passed, false);
});

test("revise failure → short-circuits with revise + feedback", async () => {
  const r = await runGateChain({ gates: [failGate("vbc", "revise"), passGate("b")], ctx: ctx() });
  strictEqual(r.shortCircuit?.action, "revise");
  ok(r.shortCircuit?.feedback?.includes("vbc failed"));
  strictEqual(r.results.length, 1, "chain stopped at the revise gate");
});

test("abort failure → short-circuits with abort + reason; later gates not run", async () => {
  let ran = false;
  const later: GateDef = { name: "later", kind: "predicate", onFail: "advise", run: async () => { ran = true; return { gate: "later", kind: "predicate", passed: true, evidence: "", onFail: "advise" }; } };
  const r = await runGateChain({ gates: [failGate("gate", "abort"), later], ctx: ctx() });
  strictEqual(r.shortCircuit?.action, "abort");
  ok(r.shortCircuit?.reason?.includes("gate failed"));
  strictEqual(ran, false, "abort short-circuits before later gates");
});

test("empty gates → empty results, no short-circuit", async () => {
  const r = await runGateChain({ gates: [], ctx: ctx() });
  deepStrictEqual(r.results, []);
  strictEqual(r.shortCircuit, undefined);
});

test("left-to-right: abort before a later advise gate (cost saved)", async () => {
  const r = await runGateChain({ gates: [failGate("gate", "abort"), failGate("v", "advise")], ctx: ctx() });
  strictEqual(r.shortCircuit?.action, "abort");
  strictEqual(r.results.length, 1);
});

test("crash path: throwing revise gate → advise (never short-circuits)", async () => {
  const throwingRevise: GateDef = {
    name: "boom", kind: "predicate", onFail: "revise",
    run: async () => { throw new Error("gate exploded"); },
  };
  const later: GateDef = { name: "later", kind: "predicate", onFail: "advise",
    run: async () => ({ gate: "later", kind: "predicate", passed: true, evidence: "", onFail: "advise" }) };
  const r = await runGateChain({ gates: [throwingRevise, later], ctx: ctx() });
  strictEqual(r.shortCircuit, undefined, "crash never short-circuits, even for onFail:revise");
  strictEqual(r.results.length, 2, "chain continued past the crash");
  strictEqual(r.results[0]!.passed, false);
  strictEqual(r.results[0]!.onFail, "advise", "crash result forced to advise");
  ok(r.results[0]!.evidence.includes("gate exploded"));
});

test("crash path: throwing abort gate → advise (never short-circuits)", async () => {
  const throwingAbort: GateDef = {
    name: "boom", kind: "predicate", onFail: "abort",
    run: async () => { throw new Error("gate exploded"); },
  };
  const r = await runGateChain({ gates: [throwingAbort], ctx: ctx() });
  strictEqual(r.shortCircuit, undefined, "crash never short-circuits, even for onFail:abort");
  strictEqual(r.results[0]!.onFail, "advise");
});