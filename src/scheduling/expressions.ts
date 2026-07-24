// src/scheduling/expressions.ts
// SPEC-5a §9 — schedule expressions: cron (vendored) + interval + one-shot (Q5=A).
// The vendored cron-parser lib (v1.1.1) is CommonJS — use createRequire for CJS-in-ESM interop.
// v1.1.1 has no `tz` option; it uses the process local timezone (the right default for a dev tool).
import { createRequire } from "node:module";

const cronRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cronParser = cronRequire("../vendor/cron-parser/lib/parser.js") as {
  parseExpression(expr: string, opts?: { currentDate?: Date; endDate?: Date }): { next(): Date; prev(): Date; hasNext(): boolean };
};

export type ScheduleType = "cron" | "interval" | "once";

export interface ScheduleExpression {
  type: ScheduleType;
  /** Next fire after `prev` (or from now if prev is null). Returns null when a one-shot has already fired. */
  nextFire(prev: Date | null): Date | null;
}

const INTERVAL_RE = /^(\d+)([smhd])$/;
const INTERVAL_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseScheduleExpr(expr: string): ScheduleExpression {
  const s = expr.trim();
  if (INTERVAL_RE.test(s)) {
    const m = s.match(INTERVAL_RE)!;
    const unit = m[2] as "s" | "m" | "h" | "d";
    const ms = Number(m[1]) * (INTERVAL_MS[unit] ?? 0);
    return {
      type: "interval",
      nextFire: (prev) => new Date((prev ?? new Date()).getTime() + ms),
    };
  }
  // one-shot ISO datetime (contains a 'T' and parses as a single Date)
  if (s.includes("T") && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const fire = new Date(s);
    if (isNaN(fire.getTime())) throw new Error(`invalid schedule expression (one-shot datetime): ${expr}`);
    let fired = false;
    return {
      type: "once",
      nextFire: (prev) => {
        if (fired) return null;
        if (prev && fire.getTime() <= prev.getTime()) { fired = true; return null; }
        fired = true;
        return fire;
      },
    };
  }
  // cron (5-field) — validate immediately (resolve-time error, not fire-time)
  try {
    cronParser.parseExpression(s, { currentDate: new Date() });
  } catch (e) {
    throw new Error(`invalid schedule expression (not cron/interval/once): ${expr} — ${(e as Error).message}`);
  }
  return {
    type: "cron",
    nextFire: (prev) => cronParser.parseExpression(s, { currentDate: prev ?? new Date() }).next(),
  };
}