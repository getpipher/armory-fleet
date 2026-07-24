// test/scheduler.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler, type ScheduleSpec } from "../src/scheduling/scheduler.ts";

function makeScheduler(onFire: (s: ScheduleSpec) => void): { sched: Scheduler; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sched-test-"));
  const sched = new Scheduler({ storePath: join(dir, "schedules.json"), lockPath: join(dir, "schedules.lock"), onFire });
  return { sched, dir };
}

test("register an interval schedule + start fires it; stop halts", async () => {
  let fired = 0;
  const { sched, dir } = makeScheduler(() => { fired++; });
  sched.register({ task: "t", expression: "1s", lifecycle: "default" });
  sched.start();
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(fired >= 1, `fired ${fired} times`);
  sched.stop();
  const snap = fired;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fired, snap, "stop halted firing");
  rmSync(dir, { recursive: true, force: true });
});

test("a one-shot schedule fires once then is auto-deleted", async () => {
  let fired = 0;
  const { sched, dir } = makeScheduler(() => { fired++; });
  const fireAt = new Date(Date.now() + 2000);
  // build a LOCAL-time ISO with second precision — new Date("…THH:mm:ss") parses as local, not UTC
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${fireAt.getFullYear()}-${pad(fireAt.getMonth() + 1)}-${pad(fireAt.getDate())}T${pad(fireAt.getHours())}:${pad(fireAt.getMinutes())}:${pad(fireAt.getSeconds())}`;
  const id = sched.register({ task: "once", expression: iso, lifecycle: "default" });
  sched.start();
  await new Promise((r) => setTimeout(r, 2800));
  sched.stop();
  assert.equal(fired, 1, `fired ${fired} times (expected exactly 1)`);
  assert.equal(sched.list().find((s) => s.id === id), undefined, "one-shot auto-deleted");
  rmSync(dir, { recursive: true, force: true });
});

test("list returns registered schedules with next-fire", () => {
  const { sched, dir } = makeScheduler(() => {});
  sched.register({ task: "t", expression: "30m", lifecycle: "default" });
  const list = sched.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.task, "t");
  assert.ok(list[0]!.nextFire instanceof Date);
  rmSync(dir, { recursive: true, force: true });
});

test("pause + resume: a paused schedule does not fire; resume re-enables", async () => {
  let fired = 0;
  const { sched, dir } = makeScheduler(() => { fired++; });
  const id = sched.register({ task: "t", expression: "1s", lifecycle: "default" });
  sched.pause(id);
  sched.start();
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fired, 0, "paused schedule fired");
  sched.resume(id);
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(fired >= 1, "resumed schedule did not fire");
  sched.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("delete removes a schedule", () => {
  const { sched, dir } = makeScheduler(() => {});
  const id = sched.register({ task: "t", expression: "30m", lifecycle: "default" });
  sched.delete(id);
  assert.equal(sched.list().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid cron errors at register time", () => {
  const { sched, dir } = makeScheduler(() => {});
  assert.throws(() => sched.register({ task: "t", expression: "not-a-cron", lifecycle: "default" }), /invalid schedule expression/);
  rmSync(dir, { recursive: true, force: true });
});

test("start is idempotent (calling twice is safe)", async () => {
  const { sched, dir } = makeScheduler(() => {});
  assert.equal(sched.start(), true);
  assert.equal(sched.start(), true); // second start no-ops (already running)
  sched.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("start creates the lock file's parent dir when it doesn't exist (fresh project)", () => {
  // Regression: in a fresh project `.pi/fleet/` doesn't exist; persist() only runs on
  // register(), so start() used to ENOENT on writeFileSync(lockPath). start() must
  // self-sufficient the dir.
  const base = mkdtempSync(join(tmpdir(), "sched-fresh-"));
  const nested = join(base, "nested", "fleet"); // does NOT exist
  const sched = new Scheduler({ storePath: join(nested, "schedules.json"), lockPath: join(nested, "schedules.lock"), onFire: () => {} });
  assert.equal(sched.start(), true, "start succeeds even though the dir is absent");
  assert.ok(existsSync(join(nested, "schedules.lock")), "lock file created");
  sched.stop();
  rmSync(base, { recursive: true, force: true });
});