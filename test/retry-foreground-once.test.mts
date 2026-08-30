// test/retry-foreground-once.test.mts
// #83 D3: the RPC foreground-semantics detached spawn's fallback retry — retry ONCE,
// only on retryable failures, only with a DISTINCT fallback model, fresh runId +
// todoId relinked from the primary (mirrors the tool's direct-path retry contract).
import { test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import { retryForegroundOnce } from "../src/engine/retry-fallback.ts";
import type { SpawnResult } from "../src/engine/spawnSubagent.ts";

const res = (over: Partial<SpawnResult>): SpawnResult => ({
  status: "failed", finalText: "", runId: "fl-primary", todoId: null, agent: "scout",
  model: "Test/primary", durationMs: 1, tokenTotal: 0, retryable: true,
  error: "model call ended with stopReason 'error'", ...over,
});

test("no fallback → primary returned untouched (single spawn call)", async () => {
  let calls = 0;
  const out = await retryForegroundOnce(res({}), undefined, async () => { calls++; return res({}); });
  strictEqual(calls, 0);
  strictEqual(out.runId, "fl-primary");
});

test("non-retryable failure → no retry (turn budget / abort / lock busy pass through)", async () => {
  let calls = 0;
  const primary = res({ retryable: undefined, error: "turn budget exceeded" });
  const out = await retryForegroundOnce(primary, "Test/fallback", async () => { calls++; return res({}); });
  strictEqual(calls, 0);
  strictEqual(out.error, "turn budget exceeded");
});

test("fallback identical to the primary model → no retry (pointless loop guard)", async () => {
  let calls = 0;
  await retryForegroundOnce(res({}), "Test/primary", async () => { calls++; return res({}); });
  strictEqual(calls, 0);
});

test("retryable failure + distinct fallback → retry fires with the fallback model + primary's todoId", async () => {
  const seen: Array<{ model?: string; todoId?: string }> = [];
  const retryRes = res({ runId: "fl-retry", model: "Test/fallback", status: "completed", finalText: "done", retryable: undefined, error: undefined });
  const out = await retryForegroundOnce(res({ todoId: "td-1" }), "Test/fallback", async (o) => {
    seen.push({ model: o?.model, todoId: o?.todoId });
    return retryRes;
  });
  deepStrictEqual(seen, [{ model: "Test/fallback", todoId: "td-1" }], "retry inherits the primary's linked todo");
  strictEqual(out.runId, "fl-retry", "the retry's OWN result wins (fresh runId — the primary's id stays retired)");
  strictEqual(out.status, "completed");
});

test("primary without a todo → retry runs unlinked", async () => {
  const seen: Array<{ todoId?: string }> = [];
  await retryForegroundOnce(res({ todoId: null }), "Test/fallback", async (o) => {
    seen.push({ todoId: o?.todoId });
    return res({ runId: "fl-retry", model: "Test/fallback", status: "completed", finalText: "done", retryable: undefined });
  });
  deepStrictEqual(seen, [{ todoId: undefined }]);
});
