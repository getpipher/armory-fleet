// test/smoke.test.mts — release-gate smoke.
// #47 lesson: the prior smoke checked builtins RENDERED, not that they PRODUCED RESULTS — so
// the broken-null-tier-name builtins shipped through v0.12.0→v0.12.3 unnoticed (status=completed
// but result=null). This gate runs every builtin workflow + asserts each PRODUCED a non-null,
// non-empty result (not just that it completed). A regression that makes a builtin return null
// (broken tier resolution, a broken agent() call, a dropped synthesis) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowIntegrationHarness,
  BUILTIN_DIR,
  BUILTIN_NAMES,
} from "./helpers/workflow-integration-harness.mts";

test("#47 release-gate: every builtin workflow PRODUCES a non-null, non-empty result (not just status=completed)", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR });
  try {
    for (const workflowName of BUILTIN_NAMES) {
      const result = await app.controller.start({ workflowName, mode: "auto", background: false, maxAgents: 100 });
      assert.equal(result.status, "completed", `${workflowName}: ${"error" in result ? result.error : ""}`);
      // #47: assert the result is REAL — non-null + non-empty when stringified. The bug class this
      // catches: a builtin that completes but returns null/undefined/"" (broken agent() or synthesis).
      assert.ok(result.result != null, `${workflowName}: result must be non-null (not the #47 null-result regression)`);
      const serialized = JSON.stringify(result.result);
      assert.ok(serialized.length > 2, `${workflowName}: result must be non-empty (got "${serialized.slice(0, 60)}")`);
      // And at least one child run was produced (the workflow actually dispatched agent() calls).
      const childRunIds = app.store.get(result.runId)?.childRunIds ?? [];
      assert.ok(childRunIds.length >= 1, `${workflowName}: produced ${childRunIds.length} child runs (expected ≥1)`);
    }
  } finally {
    app.cleanup();
  }
});