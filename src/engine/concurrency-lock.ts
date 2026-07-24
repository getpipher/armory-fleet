// src/engine/concurrency-lock.ts
export interface SingleSlotLock {
  /** true if acquired; false if busy (call .current() for the running id). */
  tryAcquire(id: string): boolean;
  release(): void;
  current(): string | null;
}

export function createSingleSlotLock(): SingleSlotLock {
  let holding: string | null = null;
  return {
    tryAcquire(id): boolean {
      if (holding !== null) return false;
      holding = id;
      return true;
    },
    release(): void {
      holding = null;
    },
    current(): string | null {
      return holding;
    },
  };
}