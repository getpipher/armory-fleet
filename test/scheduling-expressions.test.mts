// test/scheduling-expressions.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScheduleExpr } from "../src/scheduling/expressions.ts";

test("cron: weekday 9am parses + computes next fire after a Monday (local time)", () => {
  const expr = parseScheduleExpr("0 9 * * 1-5");
  assert.equal(expr.type, "cron");
  // Monday 8am local; next 9am local is the same day (Mon) if before 9am, else next weekday
  const after = new Date();
  after.setHours(8, 0, 0, 0); // today 8am local
  const next = expr.nextFire(after)!;
  assert.equal(next.getHours(), 9); // local 9am
  const dow = next.getDay();
  assert.ok(dow >= 1 && dow <= 5, `day=${dow}`);
});

test("interval: 30m parses + next fire is prev + 30min (or now if no prev)", () => {
  const expr = parseScheduleExpr("30m");
  assert.equal(expr.type, "interval");
  const prev = new Date("2026-07-27T10:00:00Z");
  const next = expr.nextFire(prev)!;
  assert.equal(next.getTime() - prev.getTime(), 30 * 60 * 1000);
});

test("once: ISO datetime parses + fires exactly once (nextFire returns same time, then null)", () => {
  const expr = parseScheduleExpr("2026-07-25T14:00");
  assert.equal(expr.type, "once");
  const next = expr.nextFire(null)!;
  assert.ok(next.toISOString().startsWith("2026-07-25T14:00") || next.toTimeString().includes("14:00"));
  assert.equal(expr.nextFire(next), null);
});

test("invalid cron errors at parse time (resolve-time, not fire time)", () => {
  assert.throws(() => parseScheduleExpr("not-a-cron"), /invalid schedule expression/);
});

test("interval rejects unknown units", () => {
  assert.throws(() => parseScheduleExpr("30x"), /invalid schedule expression/);
});