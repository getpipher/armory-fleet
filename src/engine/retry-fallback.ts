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
      const second = await spawn({ ...opts, model: fallback });
      // #59: when the fallback also fails, compose the primary's failure into the surfaced error
      // (same contract as the direct-foreground path in tools/subagent.ts) — the fallback's error
      // alone masks why the primary failed.
      if (second.status === "failed" && first.error && first.error !== second.error) {
        second.error = `primary '${first.model}' failed: ${first.error}; fallback '${fallback}' failed: ${second.error ?? second.status}`;
      }
      return second;
    }
    return first;
  };
}

/** #83 D3: the RPC foreground-semantics detached spawn's retry — mirrors the tool's direct-path
 *  contract (retry ONCE, retryable failures only, DISTINCT fallback model) but the retry runs
 *  WITHOUT the pre-minted runId: the primary already journaled run:started/ended under it, so
 *  the retry must mint a fresh id (a reused id would double-emit run:started). `todoId` links
 *  the retry to the primary's armory-todo task (same relink contract as the tool). */
export async function retryForegroundOnce(
  primary: SpawnResult,
  fallback: string | undefined,
  spawn: (o: { model: string; todoId?: string }) => Promise<SpawnResult>,
): Promise<SpawnResult> {
  if (!fallback || primary.status !== "failed" || !primary.retryable || fallback === primary.model) return primary;
  return spawn({ model: fallback, todoId: primary.todoId ?? undefined });
}
