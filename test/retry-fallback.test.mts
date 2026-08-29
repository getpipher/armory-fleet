// test/retry-fallback.test.mts — #39 tail: withModelFallbackRetry (lifecycle/bg spawn retry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withModelFallbackRetry } from "../src/engine/retry-fallback.ts";
import type { SpawnResult } from "../src/engine/spawnSubagent.ts";
import type { SpawnFn, PhaseSpawnOpts } from "../src/lifecycle/run-lifecycle.ts";

type FakeSpawn = SpawnFn;

function res(over: Partial<SpawnResult> = {}): SpawnResult {
  return {
    status: "failed", finalText: "", runId: "r1", todoId: null, agent: "g", model: "primary",
    durationMs: 1, tokenTotal: 0, error: "boom", ...over,
  };
}

/** Counting fake spawn: returns a scripted result per call, recording the model each call used. */
function fakeSpawn(results: SpawnResult[]): { fn: FakeSpawn; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (o: PhaseSpawnOpts): Promise<SpawnResult> => {
    calls.push(o.model ?? "(none)");
    return results.shift() ?? res();
  }) as FakeSpawn;
  return { fn, calls };
}

const baseOpts: PhaseSpawnOpts = { agent: "g", task: "x", lifecycleTodoId: "t1", skills: [], backend: "pi" };

test("#39 wrapper: fallback undefined → spawn unchanged (no retry, no wrapping)", async () => {
  const { fn, calls } = fakeSpawn([res({ status: "completed", model: "primary" })]);
  const wrapped = withModelFallbackRetry(fn, undefined);
  assert.equal(wrapped, fn, "undefined fallback returns the original fn (no wrapping)");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "completed");
  assert.deepEqual(calls, ["(none)"], "single call, no retry");
});

test("#39 wrapper: retryable failure + fallback → retries ONCE on the fallback model", async () => {
  const { fn, calls } = fakeSpawn([
    res({ retryable: true, model: "primary" }),
    res({ status: "completed", model: "fallback", finalText: "ok" }),
  ]);
  const wrapped = withModelFallbackRetry(fn, "fallback");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "completed", "retry succeeded");
  assert.equal(out.model, "fallback", "retry's result (model=fallback) wins");
  assert.deepEqual(calls, ["(none)", "fallback"], "called twice: primary then fallback");
});

test("#39 wrapper: non-retryable failure (turn budget, retryable unset) → NO retry", async () => {
  const { fn, calls } = fakeSpawn([res({ retryable: false, model: "primary", error: "hit turn budget" })]);
  const wrapped = withModelFallbackRetry(fn, "fallback");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "failed");
  assert.equal(out.error, "hit turn budget");
  assert.deepEqual(calls, ["(none)"], "no retry on non-retryable failure");
});

test("#39 wrapper: fallback === primary model → NO retry (avoids retrying the same failing model)", async () => {
  const { fn, calls } = fakeSpawn([res({ retryable: true, model: "primary" })]);
  const wrapped = withModelFallbackRetry(fn, "primary");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "failed");
  assert.deepEqual(calls, ["(none)"], "no retry when fallback === primary");
});

test("#39 wrapper: completed (non-failed) first result → NO retry", async () => {
  const { fn, calls } = fakeSpawn([res({ status: "completed", model: "primary", finalText: "ok" })]);
  const wrapped = withModelFallbackRetry(fn, "fallback");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "completed");
  assert.deepEqual(calls, ["(none)"], "no retry when first call succeeded");
});

test("#39 wrapper: signal already aborted → NO retry (even on retryable failure)", async () => {
  const ac = new AbortController();
  ac.abort();
  const { fn, calls } = fakeSpawn([res({ retryable: true, model: "primary" })]);
  const wrapped = withModelFallbackRetry(fn, "fallback", ac.signal);
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "failed", "first (failed) result returned");
  assert.deepEqual(calls, ["(none)"], "no retry when signal aborted");
});

test("#59: both attempts fail → returned error includes the PRIMARY's failure (no masking)", async () => {
  const { fn, calls } = fakeSpawn([
    res({ retryable: true, model: "Ollama/glm", error: "rate limited" }),
    res({ model: "openrouter/glm", error: "also rate limited" }),
  ]);
  const wrapped = withModelFallbackRetry(fn, "openrouter/glm");
  const out = await wrapped(baseOpts);
  assert.equal(out.status, "failed");
  assert.deepEqual(calls, ["(none)", "openrouter/glm"], "retried once on the fallback");
  assert.ok(out.error!.includes("Ollama/glm"), `names the primary model: ${out.error}`);
  assert.ok(out.error!.includes("rate limited"), "includes the primary's error text");
  assert.ok(out.error!.includes("openrouter/glm"), "names the fallback model");
  assert.ok(out.error!.includes("also rate limited"), "includes the fallback's error text");
});
