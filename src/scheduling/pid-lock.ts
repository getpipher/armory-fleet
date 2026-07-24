// src/scheduling/pid-lock.ts
// SPEC-5a §9 — PID lock so only one pi session fires schedules (Q5=A).
// A stale PID (dead process) is reclaimed.
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

export class PidLock {
  private lockPath: string | null = null;

  acquire(lockPath: string): boolean {
    if (existsSync(lockPath)) {
      const raw = readFileSync(lockPath, "utf8").trim();
      const ownerPid = Number(raw);
      if (Number.isFinite(ownerPid) && ownerPid !== process.pid && isPidAlive(ownerPid)) {
        // a different live process owns it
        return false;
      }
      // stale pid (dead) or already us → reclaim/keep
    }
    writeFileSync(lockPath, String(process.pid), "utf8");
    this.lockPath = lockPath;
    return true;
  }

  isOwner(): boolean {
    return this.lockPath !== null;
  }

  release(): void {
    if (this.lockPath && existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
    this.lockPath = null;
  }
}