import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completenessCheckGate, checkCompleteness } from "../src/lifecycle/gates/completeness-check.ts";

const tmp = mkdtempSync(join(tmpdir(), "fleet-cc-"));
test("checkCompleteness: all paths exist → passed", () => {
  writeFileSync(join(tmp, "a.ts"), "x");
  writeFileSync(join(tmp, "b.ts"), "y");
  const r = checkCompleteness([join(tmp, "a.ts"), join(tmp, "b.ts")], tmp);
  ok(r.passed);
  ok(r.evidence.includes("2/2"));
});

test("checkCompleteness: missing path → failed with the missing path", () => {
  const r = checkCompleteness([join(tmp, "a.ts"), join(tmp, "nope.ts")], tmp);
  strictEqual(r.passed, false);
  ok(r.evidence.includes("nope.ts"));
});

test("checkCompleteness: empty paths → passed (terminal-phase exemption)", () => {
  const r = checkCompleteness([], tmp);
  ok(r.passed, "no claimed artifacts → nothing to check");
});

test("checkCompleteness: relative paths resolved against baseDir", () => {
  writeFileSync(join(tmp, "rel.ts"), "x");
  const r = checkCompleteness(["rel.ts"], tmp);
  ok(r.passed);
});

const ctx = (paths: string[], worktreePath?: string) => ({
  phaseRec: { name: "implement", summary: "", paths, status: "completed" as const, reviseCount: 0 },
  spawnRes: { status: "completed" as const, finalText: "", runId: "fl-x", todoId: null, agent: "a", model: "m", durationMs: 0, tokenTotal: 0 },
  lifecycle: { name: "default", task: "t", todoId: "todo1", backend: "pi" as const },
  lifecycleCost: 0, contextTokens: 0, worktreePath, gateParams: undefined,
  spawn: async () => { throw new Error("not used"); },
  getModelContextWindow: () => undefined,
});

test("gate: onFail revise, kind predicate", () => {
  strictEqual(completenessCheckGate.onFail, "revise");
  strictEqual(completenessCheckGate.kind, "predicate");
});

test("gate.run: uses worktreePath when set", async () => {
  writeFileSync(join(tmp, "wt.ts"), "x");
  const r = await completenessCheckGate.run(ctx(["wt.ts"], tmp));
  ok(r.passed);
});

test("gate.run: missing → failed", async () => {
  const r = await completenessCheckGate.run(ctx(["ghost.ts"], tmp));
  strictEqual(r.passed, false);
});

// cleanup after all
test("cleanup", () => { rmSync(tmp, { recursive: true, force: true }); ok(true); });