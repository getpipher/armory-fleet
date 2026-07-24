// src/runtime/concurrency-pool.ts
// SPEC-5a §8 — N-slot semaphore for async/bg runs (Q4=A). Foreground keeps its own
// single-slot lock (unchanged); this pool is independent.

export class ConcurrencyPool {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly cap = 3) {}

  busy(): number { return this.active; }
  queued(): number { return this.waiters.length; }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.cap) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}