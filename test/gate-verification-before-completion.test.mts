import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { verificationBeforeCompletionGate, scanVerificationEvidence } from "../src/lifecycle/gates/verification-before-completion.ts";

const ctx = (finalText: string) => ({
  phaseRec: { name: "implement", summary: "", paths: [], status: "completed" as const, reviseCount: 0 },
  spawnRes: { status: "completed" as const, finalText, runId: "fl-x", todoId: null, agent: "a", model: "m", durationMs: 0, tokenTotal: 0 },
  lifecycle: { name: "default", task: "t", todoId: "todo1", backend: "pi" as const },
  lifecycleCost: 0, contextTokens: 0,
  spawn: async () => { throw new Error("not used"); },
  getModelContextWindow: () => undefined,
  gateParams: undefined,
});

test("scanVerificationEvidence: detects test command + pass output", () => {
  ok(scanVerificationEvidence("I ran `pnpm test:run` — 368 pass, 0 fail").passed);
  ok(scanVerificationEvidence("typecheck: exit 0, clean").passed);
  ok(scanVerificationEvidence("$ pnpm typecheck\n0 errors").passed);
});

test("scanVerificationEvidence: bare claim with no command → fails", () => {
  strictEqual(scanVerificationEvidence("Done! I implemented the feature.").passed, false);
  strictEqual(scanVerificationEvidence("The work is complete.").passed, false);
});

test("scanVerificationEvidence: command but no exit/pass signal → fails", () => {
  strictEqual(scanVerificationEvidence("I ran pnpm test:run").passed, false, "command alone without result is not evidence");
});

test("scanVerificationEvidence: custom patterns override", () => {
  const r = scanVerificationEvidence("custom-check: green", { patterns: [/custom-check:\s*(green|ok)/i] });
  ok(r.passed, "custom pattern matches");
  strictEqual(scanVerificationEvidence("pnpm test:run — 368 pass", { patterns: [/custom-check/]}).passed, false, "custom patterns replace defaults");
});

test("gate: onFail is revise", () => {
  strictEqual(verificationBeforeCompletionGate.onFail, "revise");
  strictEqual(verificationBeforeCompletionGate.kind, "predicate");
});

test("gate.run: evidence present → passed", async () => {
  const r = await verificationBeforeCompletionGate.run(ctx("ran `pnpm test:run` → 368 pass"));
  strictEqual(r.passed, true);
  ok(r.evidence.includes("pnpm test:run"));
});

test("gate.run: no evidence → failed with actionable message", async () => {
  const r = await verificationBeforeCompletionGate.run(ctx("done"));
  strictEqual(r.passed, false);
  ok(r.evidence.includes("no verification command output"), r.evidence);
});