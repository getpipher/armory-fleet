// src/engine/concurrency-lock.ts
// #31 tail: the foreground concurrency lock. A cap-based semaphore shared across all
// foreground subagent dispatches (serializes writes to prevent in-place edit conflicts).
//
// - cap=1 (default, backward-compat): FAIL-FAST. A 2nd dispatch while one is running is
//   rejected with `{ ok: false, busy }` so the orchestrator gets an actionable error (the
//   held runId is named) instead of blocking. This preserves the pre-#31 behavior exactly.
// - cap>1 (opt-in via ARMORY_FLEET_FOREGROUND_CONCURRENCY): QUEUE. Up to `cap` write
//   dispatches run in parallel; the (cap+1)th WAITS for a slot (not rejected).
//
// #31 design note: concurrency is SESSION-LEVEL (env/settings), NOT a per-dispatch param.
// A shared lock serializes across dispatches, so a per-dispatch `concurrency` param can't
// re-size it per-call (two dispatches requesting different caps have no consistent global
// cap). The cap is fixed at init. The subagent tool's promptGuidelines surface this to the
// orchestrator so it understands the behavior + how to change it.
//
// readOnly dispatches bypass the lock entirely (#41) — they assert no cwd mutation.

export type AcquireResult =
  | { ok: true }
  | { ok: false; busy: string[] };

export interface ForegroundLock {
  /** The configured cap (1 = fail-fast; >1 = queue). */
  readonly cap: number;
  /** Acquire a slot for `runId`. At cap=1: fail-fast if busy (returns the held runIds).
   *  At cap>1: waits (queues) if at cap, then acquires. */
  acquire(runId: string): Promise<AcquireResult>;
  /** Release a held slot. No-op if `runId` isn't held (guard against double-release). */
  release(runId: string): void;
  /** RunIds currently holding a slot (for diagnostics + error messages). */
  holders(): string[];
}

export class ForegroundLockImpl implements ForegroundLock {
  private active: string[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly cap = 1) {}

  acquire(runId: string): Promise<AcquireResult> {
    if (this.active.length >= this.cap) {
      if (this.cap === 1) {
        // Backward-compat: fail-fast at cap=1. The orchestrator gets the held runId + the cap
        // + the env hint, so it can wait/abort or raise the cap.
        return Promise.resolve({ ok: false, busy: [...this.active] });
      }
      // cap>1: queue — resolve when a slot frees (FIFO).
      return new Promise<AcquireResult>((resolve) => {
        this.waiters.push(() => { this.active.push(runId); resolve({ ok: true }); });
      });
    }
    this.active.push(runId);
    return Promise.resolve({ ok: true });
  }

  release(runId: string): void {
    const i = this.active.indexOf(runId);
    if (i < 0) return;   // no-op if not held (don't wake a waiter without freeing a slot)
    this.active.splice(i, 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  holders(): string[] { return [...this.active]; }
}

/** Configurable foreground lock. cap from `ARMORY_FLEET_FOREGROUND_CONCURRENCY` (default 1). */
export function createForegroundLock(cap = 1): ForegroundLock {
  return new ForegroundLockImpl(cap);
}

/** Backward-compat factory: a cap=1 fail-fast lock. Existing call sites pass this to
 *  spawnSubagent; it now returns a ForegroundLock(1) with the same cap=1 semantics. */
export function createSingleSlotLock(): ForegroundLock {
  return new ForegroundLockImpl(1);
}

/** @deprecated alias kept for call sites that construct `new SingleSlotLock()` or type
 *  `lock: SingleSlotLock` (workflow adapters, fleet-panel). Same as ForegroundLock(1). */
export type SingleSlotLock = ForegroundLock;
export const SingleSlotLock = ForegroundLockImpl;
