// src/engine/concurrency-lock.ts
export interface SingleSlotLock {
  /** true if acquired; false if busy (call .current() for the running id). */
  tryAcquire(id: string): boolean;
  release(): void;
  current(): string | null;
}

export class SingleSlotLockImpl implements SingleSlotLock {
  private holding: string | null = null;
  tryAcquire(id: string): boolean {
    if (this.holding !== null) return false;
    this.holding = id;
    return true;
  }
  release(): void {
    this.holding = null;
  }
  current(): string | null {
    return this.holding;
  }
}

/** Alias so tests can `new SingleSlotLock()`. */
export const SingleSlotLock = SingleSlotLockImpl;

export function createSingleSlotLock(): SingleSlotLock {
  return new SingleSlotLock();
}
