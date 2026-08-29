// test/smoke.test.mts — release-gate smoke.
// #47 lesson: the prior smoke checked builtins RENDERED, not that they PRODUCED RESULTS — so
// the broken-null-tier-name builtins shipped through v0.12.0→v0.12.3 unnoticed (status=completed
// but result=null). This gate runs every builtin workflow + asserts each PRODUCED a non-null,
// non-empty result (not just that it completed). A regression that makes a builtin return null
// (broken tier resolution, a broken agent() call, a dropped synthesis) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowIntegrationHarness,
  BUILTIN_DIR,
  BUILTIN_NAMES,
} from "./helpers/workflow-integration-harness.mts";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { FleetEventBus } from "../src/rpc/event-bus.ts";
import { RpcServer } from "../src/rpc/rpc-server.ts";

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
// SPEC-6-4 release-gate: fleet rpc round-trip — bus publish + status/observe over real journals.
// Env-independent: real RunLog/RunJournal/RunRegistry + real FleetEventBus/RpcServer, no pi import.
test("SPEC-6-4 release-gate: fleet rpc round-trip — bus publish + status/observe over real journals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rpc-smoke-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const journal = new RunJournal(join(dir, "runs"));
    const registry = new RunRegistry();
    const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const bus = new FleetEventBus({ runLog, journal, emit: (channel, payload) => emitted.push({ channel, payload: payload as Record<string, unknown> }) });
    const server = new RpcServer({
      runRegistry: registry, runLog, journal, parentCwd: dir, hasAsyncRunner: false, spawn: () => {},
    });
    runLog.append("fl-smoke", { type: "run:meta", runId: "fl-smoke", agent: "scout", model: "Test/m", task: "smoke", startedAt: Date.now(), track: false, todoId: null });
    runLog.append("fl-smoke", { type: "message", role: "assistant", text: "hi", turnIndex: 0 });
    assert.ok(emitted.some((e) => e.channel === "fleet:run:started"), "bus published run:started");
    assert.ok(emitted.some((e) => e.channel === "fleet:child:message"), "bus published child:message");
    const status = await server.handle({ id: "smoke-1", verb: "status", params: {} });
    assert.equal(status?.ok, true, "status replies ok");
    const observe = await server.handle({ id: "smoke-2", verb: "observe", params: { runId: "fl-smoke", tier: "child" } }) as { ok: boolean; data?: { events: unknown[] } };
    assert.equal(observe.ok, true);
    assert.equal(observe.data?.events.length, 1, "observe replays the journaled child event");
    bus.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
