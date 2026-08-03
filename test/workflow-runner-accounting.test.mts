import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/workflows/runner.ts";
import { deps, cleanup } from "./helpers/workflow-runner-fixture.mts";

test("direct and helper children share accounting and option forwarding", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const d = deps({ spawn: async (_prompt, opts) => {
    calls.push(opts);
    n++;
    return { finalText: n === 1 ? "direct" : '{"real":true,"reason":"ok"}', runId: `fl-${n}`, status: "completed" as const, tokenTotal: 10, costTotal: 0.25 };
  }});
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => { await agent('a', { tier:'high', skills:['s'], backend:'claude' }); await verify('x', { reviewers:1, tier:'low', model:'p/m' }); return 1 })()",
      mode: "auto",
    }, d);
    assert.equal(result.tokenTotal, 20);
    assert.equal(result.costTotal, 0.5);
    assert.deepEqual(result.childRunIds, ["fl-1", "fl-2"]);
    assert.equal(calls[0]?.tier, "high");
    assert.deepEqual(calls[0]?.skills, ["s"]);
    assert.equal(calls[0]?.backend, "claude");
    assert.equal(calls[1]?.tier, "low");
    assert.equal(calls[1]?.model, "p/m");
  } finally { cleanup(d); }
});

test("non-schema agent preserves a valid-JSON-looking string", async () => {
  const d = deps({ spawn: async () => ({ finalText: '"quoted"', runId: "fl-1", status: "completed" as const, tokenTotal: 1, costTotal: 0 }) });
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => await agent('a'))()", mode: "auto",
    }, d);
    assert.equal(result.result, '"quoted"');
  } finally { cleanup(d); }
});

test("nested workflows merge child accounting once", async () => {
  const d = deps({ resolveWorkflow: () => ({ sourceText: "return await agent('child')", executable: "module.exports = (async () => await agent('child'))()" }) });
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => await workflow('child'))()", mode: "auto", budget: { total: 20 },
    }, d);
    assert.equal(result.tokenTotal, 10);
    assert.equal(result.costTotal, 0.1);
    assert.equal(result.childRunIds.length, 1);
  } finally { cleanup(d); }
});

test("run-level retries apply to recoverable failures but not isolation fail-fast", async () => {
  let attempts = 0;
  const d = deps({ spawn: async () => {
    attempts++;
    return attempts === 1
      ? { finalText: "", runId: "fl-1", status: "failed" as const }
      : { finalText: "ok", runId: "fl-2", status: "completed" as const };
  }});
  try {
    const result = await runWorkflow("x", {
      script: "module.exports = (async () => await agent('a'))()", mode: "auto", agentRetries: 1,
    }, d);
    assert.equal(result.result, "ok");
    assert.equal(attempts, 2);
  } finally { cleanup(d); }
});
