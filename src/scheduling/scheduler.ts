// src/scheduling/scheduler.ts
// SPEC-5a §9 — in-process scheduler. Session-scoped (fires only while pi open, no daemon).
// PID-locked so two open pi sessions on the same project don't double-fire. No catch-up.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseScheduleExpr, type ScheduleExpression } from "./expressions.ts";
import { PidLock } from "./pid-lock.ts";

export interface ScheduleSpec {
  task: string;
  expression: string;
  lifecycle?: string; // default "default"
  auto?: boolean;
  /** v0.11.1: edit isolation for the background run on fire. Default "auto". */
  isolation?: "worktree" | "none" | "auto";
  /** #62: the dispatch target cwd (undefined = session cwd). Threaded to runBackground on fire. */
  cwd?: string;
}

export interface Schedule extends ScheduleSpec {
  id: string;
  nextFire: Date | null;
  paused: boolean;
}

interface StoredSchedule extends ScheduleSpec {
  id: string;
  paused: boolean;
}

export interface SchedulerOpts {
  storePath: string;
  lockPath: string;
  onFire: (spec: ScheduleSpec) => void;
}

interface Entry { spec: StoredSchedule; expr: ScheduleExpression; timer: NodeJS.Timeout | null }

export class Scheduler {
  private schedules = new Map<string, Entry>();
  private pidLock = new PidLock();
  private running = false;

  constructor(private readonly opts: SchedulerOpts) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.opts.storePath)) return;
    try {
      const arr = JSON.parse(readFileSync(this.opts.storePath, "utf8")) as StoredSchedule[];
      for (const s of arr) {
        try {
          const expr = parseScheduleExpr(s.expression);
          this.schedules.set(s.id, { spec: s, expr, timer: null });
        } catch {
          // skip a schedule whose expression no longer parses
        }
      }
    } catch { /* corrupt store — start empty */ }
  }

  private persist(): void {
    mkdirSync(dirname(this.opts.storePath), { recursive: true });
    const arr = [...this.schedules.values()].map((e) => e.spec);
    writeFileSync(this.opts.storePath, JSON.stringify(arr, null, 2), "utf8");
  }

  register(spec: ScheduleSpec): string {
    const expr = parseScheduleExpr(spec.expression); // throws on invalid → resolve-time error
    const id = "sch-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stored: StoredSchedule = {
      id,
      task: spec.task,
      expression: spec.expression,
      lifecycle: spec.lifecycle ?? "default",
      auto: spec.auto ?? true,
      isolation: spec.isolation,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      paused: false,
    };
    this.schedules.set(id, { spec: stored, expr, timer: null });
    this.persist();
    if (this.running) this.arm(id);
    return id;
  }

  list(): Schedule[] {
    return [...this.schedules.values()].map((e) => ({
      id: e.spec.id,
      task: e.spec.task,
      expression: e.spec.expression,
      lifecycle: e.spec.lifecycle,
      auto: e.spec.auto,
      isolation: e.spec.isolation,
      ...(e.spec.cwd ? { cwd: e.spec.cwd } : {}),
      paused: e.spec.paused,
      nextFire: e.spec.paused ? null : e.expr.nextFire(new Date()),
    }));
  }

  pause(id: string): void {
    const e = this.schedules.get(id);
    if (!e) return;
    e.spec.paused = true;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    this.persist();
  }

  resume(id: string): void {
    const e = this.schedules.get(id);
    if (!e) return;
    e.spec.paused = false;
    if (this.running) this.arm(id);
    this.persist();
  }

  delete(id: string): void {
    const e = this.schedules.get(id);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.schedules.delete(id);
    this.persist();
  }

  start(): boolean {
    if (this.running) return true;
    // Ensure the lock file's parent dir exists (fresh projects have no `.pi/fleet/` yet;
    // persist() only runs on register(), so start() must self-sufficient the dir first).
    mkdirSync(dirname(this.opts.lockPath), { recursive: true });
    if (!this.pidLock.acquire(this.opts.lockPath)) return false;
    this.running = true;
    for (const id of this.schedules.keys()) this.arm(id);
    return true;
  }

  stop(): void {
    if (!this.running) return;
    for (const e of this.schedules.values()) if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    this.pidLock.release();
    this.running = false;
  }

  private arm(id: string): void {
    const e = this.schedules.get(id);
    if (!e || e.spec.paused) return;
    const now = new Date();
    const next = e.expr.nextFire(now);
    if (!next) { this.delete(id); return; } // one-shot exhausted
    const delay = Math.max(0, next.getTime() - now.getTime());
    e.timer = setTimeout(() => {
      this.opts.onFire(e.spec);
      const nx = e.expr.nextFire(new Date());
      if (!nx) { this.delete(id); return; }
      this.arm(id);
    }, delay);
  }
}