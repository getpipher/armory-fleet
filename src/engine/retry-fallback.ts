// src/engine/retry-fallback.ts
// #39 tail: a reusable retry wrapper for the lifecycle + background spawn sites, where the
// direct-foreground path's inline retry (subagent.ts) doesn't reach. Mirrors that path's
// contract: retry ONCE, only on a retryable provider rate-limit / auth failure (stopReason
// "error" → SpawnResult.retryable), only with a DISTINCT fallback model, only when not aborted.
// Non-retryable failures (turn budget, agent-not-found, EMPTY_RESULT, abort, lock busy) pass
// through unchanged. Lifecycle/bg retries are transparent — the retry's SpawnResult (with
// model = fallback) wins; the direct-foreground path separately surfaces `retriedWithModel`
// in the tool details, which lifecycle/bg don't need.
import type { SpawnResult } from "./spawnSubagent.ts";
import type { SpawnFn } from "../lifecycle/run-lifecycle.ts";

/** Wrap a lifecycle/bg SpawnFn so a retryable failure retries once on `fallback`. `fallback`
 *  being undefined returns the spawn unchanged (no global default + no per-dispatch param → no
 *  retry). `signal` optional — background/panel sites have no AbortSignal; the direct path checks
 *  abort inline. */
export function withModelFallbackRetry(spawn: SpawnFn, fallback: string | undefined, signal?: AbortSignal): SpawnFn {
  if (!fallback) return spawn;
  return async (opts) => {
    const first = await spawn(opts);
    if (first.status === "failed" && first.retryable && fallback !== first.model && !signal?.aborted) {
      return spawn({ ...opts, model: fallback });
    }
    return first;
  };
}
