import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { buildGateLine, gateGlyph } from "../src/panel/gate-line.ts";
import type { GateResult } from "../src/lifecycle/gates/registry.ts";

const r = (gate: string, passed: boolean, onFail: "advise"|"revise"|"abort" = "advise"): GateResult =>
  ({ gate, kind: "predicate", passed, evidence: "", onFail });

test("gateGlyph: passed → ✓", () => { strictEqual(gateGlyph(r("v", true)), "✓"); });
test("gateGlyph: failed + abort → ✗", () => { strictEqual(gateGlyph(r("gate", false, "abort")), "✗"); });
test("gateGlyph: failed + revise → ↻", () => { strictEqual(gateGlyph(r("vbc", false, "revise")), "↻"); });
test("gateGlyph: failed + advise → ⚠", () => { strictEqual(gateGlyph(r("verify", false, "advise")), "⚠"); });

test("buildGateLine: empty results → empty string", () => {
  strictEqual(buildGateLine([]), "");
});

test("buildGateLine: mixed results → compact glyph line", () => {
  const line = buildGateLine([r("verification-before-completion", true), r("completenessCheck", true), r("gate", false, "abort")]);
  ok(line.includes("✓verification-before-completion"));
  ok(line.includes("✓completenessCheck"));
  ok(line.includes("✗gate"));
});

test("buildGateLine: abort short-circuit suffix", () => {
  const line = buildGateLine([r("gate", false, "abort")]);
  ok(line.includes("→ aborted"));
});

test("buildGateLine: revise short-circuit suffix", () => {
  const line = buildGateLine([r("vbc", false, "revise")]);
  ok(line.includes("→ revising"));
});