import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { verifyGate, judgeReview, buildVerifyPrompt } from "../src/lifecycle/gates/verify.ts";
import type { SpawnResult } from "../src/engine/spawnSubagent.ts";

const okSpawn = async (): Promise<SpawnResult> => ({
  status: "completed", finalText: "The implementation meets the requirement. All plan items addressed.",
  runId: "fl-rev", todoId: "todo1", agent: "reviewer", model: "m", durationMs: 100, tokenTotal: 50, costTotal: 0.01,
});
const badSpawn = async (): Promise<SpawnResult> => ({
  status: "completed", finalText: "The implementation does not meet the requirement. Missing edge case for empty input.",
  runId: "fl-rev2", todoId: "todo1", agent: "reviewer", model: "m", durationMs: 100, tokenTotal: 50, costTotal: 0.01,
});
const crashSpawn = async (): Promise<SpawnResult> => ({
  status: "failed", finalText: "", runId: "fl-rev3", todoId: "todo1", agent: "reviewer", model: "m", durationMs: 0, tokenTotal: 0, error: "boom",
});

const ctx = (spawn: typeof okSpawn) => ({
  phaseRec: { name: "review", summary: "impl done", paths: ["src/a.ts"], status: "completed" as const, reviseCount: 0 },
  spawnRes: { status: "completed" as const, finalText: "impl", runId: "fl-x", todoId: "todo1", agent: "a", model: "m", durationMs: 0, tokenTotal: 0 },
  lifecycle: { name: "default", task: "build the foo feature", todoId: "todo1", backend: "pi" as const },
  lifecycleCost: 0.42, contextTokens: 27000, gateParams: undefined, spawn,
  getModelContextWindow: () => undefined,
});

test("judgeReview: positive review → passed", () => {
  ok(judgeReview("Meets the requirement. All items addressed.").passed);
});

test("judgeReview: failure markers → failed", () => {
  strictEqual(judgeReview("Does not meet the requirement. Missing edge case.").passed, false);
  strictEqual(judgeReview("The work is incomplete — X not addressed.").passed, false);
});

test("buildVerifyPrompt: includes task + phase summary + paths", () => {
  const p = buildVerifyPrompt(ctx(okSpawn));
  ok(p.includes("build the foo feature"));
  ok(p.includes("impl done"));
  ok(p.includes("src/a.ts"));
});

test("gate: onFail advise, kind agent", () => {
  strictEqual(verifyGate.onFail, "advise");
  strictEqual(verifyGate.kind, "agent");
});

test("gate.run: positive review → passed + cost + runId", async () => {
  const r = await verifyGate.run(ctx(okSpawn));
  strictEqual(r.passed, true);
  strictEqual(r.cost, 0.01);
  strictEqual(r.runId, "fl-rev");
});

test("gate.run: negative review → failed + advise", async () => {
  const r = await verifyGate.run(ctx(badSpawn));
  strictEqual(r.passed, false);
  strictEqual(r.onFail, "advise");
  ok(r.evidence.includes("Missing edge case"));
});

test("gate.run: spawn crash → failed + advise (not revise)", async () => {
  const r = await verifyGate.run(ctx(crashSpawn));
  strictEqual(r.passed, false);
  strictEqual(r.onFail, "advise", "crash → advise, not revise (can't fix a crash by re-running the phase)");
  ok(r.evidence.includes("reviewer spawn failed"));
});

test("gate.run: params.agent pins the reviewer agent", async () => {
  let captured: string | undefined;
  const spySpawn = async (o: { agent: string }): Promise<SpawnResult> => { captured = o.agent; return await okSpawn(); };
  const c = { ...ctx(spySpawn as any), gateParams: { agent: "senior-reviewer" } };
  await verifyGate.run(c);
  strictEqual(captured, "senior-reviewer");
});