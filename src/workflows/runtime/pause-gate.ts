// SPEC-6-3 cooperative pause gate — blocks new work when paused, releases all waiters on resume,
// rejects waiters on abort signal.

export class PauseGate {
  private paused = false;
  private readonly waiters = new Set<() => void>();

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const toRelease = [...this.waiters];
    this.waiters.clear();
    for (const resolve of toRelease) resolve();
  }

  isPaused(): boolean {
    return this.paused;
  }

  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(resolve);
        reject(signal.reason);
      };

      const resolveFn = () => {
        signal.removeEventListener("abort", onAbort, { once: true } as EventListenerOptions);
        resolve();
      };

      this.waiters.add(resolveFn);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
