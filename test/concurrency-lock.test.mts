// test/concurrency-lock.test.mts — #31 tail: ForegroundLock (cap-based semaphore).
import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { createSingleSlotLock, createForegroundLock } from "../src/engine/concurrency-lock.ts";

test("cap=1: first acquire succeeds + names the holder", async () => {
  const l = createSingleSlotLock();
  const acq = await l.acquire("fl-1");
  ok(acq.ok, "first acquire succeeds");
  deepStrictEqual(l.holders(), ["fl-1"], "holders names fl-1");
});

test("cap=1: second acquire FAIL-FASTS (backward-compat) + names the held runId", async () => {
  const l = createSingleSlotLock();
  await l.acquire("fl-1");
  const acq = await l.acquire("fl-2");
  ok(!acq.ok, "second acquire fails fast at cap=1");
  if (!acq.ok) deepStrictEqual(acq.busy, ["fl-1"], "rejection names the held runId");
  deepStrictEqual(l.holders(), ["fl-1"], "the failed acquire did not take a slot");
});

test("cap=1: release frees the slot for the next acquire", async () => {
  const l = createSingleSlotLock();
  await l.acquire("fl-1");
  l.release("fl-1");
  const acq = await l.acquire("fl-2");
  ok(acq.ok, "next acquire succeeds after release");
  deepStrictEqual(l.holders(), ["fl-2"]);
});

test("cap=1: release(runId) is a no-op for an unheld id (double-release guard)", async () => {
  const l = createSingleSlotLock();
  await l.acquire("fl-1");
  l.release("fl-not-held"); // no-op — must NOT free the held slot
  const acq = await l.acquire("fl-2");
  ok(!acq.ok, "slot still held — release of an unheld id did not free it");
});

test("cap=3: up to 3 run in parallel; the 4th WAITS (not rejected)", async () => {
  const l = createForegroundLock(3);
  const a1 = await l.acquire("r1"); ok(a1.ok);
  const a2 = await l.acquire("r2"); ok(a2.ok);
  const a3 = await l.acquire("r3"); ok(a3.ok);
  deepStrictEqual(l.holders(), ["r1", "r2", "r3"], "3 slots held");
  // 4th acquire at cap → must queue (not resolve immediately).
  let fourthResolved = false;
  const fourth = l.acquire("r4").then((r) => { fourthResolved = true; return r; });
  await new Promise((r) => setImmediate(r));
  strictEqual(fourthResolved, false, "4th acquire is queued (not rejected, not yet acquired)");
  strictEqual(l.holders().length, 3, "still 3 held while 4th waits");
  // release one → 4th acquires
  l.release("r1");
  const r4 = await fourth;
  ok(r4.ok, "4th acquired after a release");
  deepStrictEqual(l.holders(), ["r2", "r3", "r4"], "r1 freed, r4 took its slot");
});

test("cap=3: holders() snapshots the active runIds", async () => {
  const l = createForegroundLock(3);
  await l.acquire("a"); await l.acquire("b");
  deepStrictEqual(l.holders(), ["a", "b"]);
  l.release("a");
  deepStrictEqual(l.holders(), ["b"], "released id dropped from holders");
});

test("cap=3: release(wrong-id) is a no-op even with waiters queued (no phantom slot)", async () => {
  // Regression guard for the release() blocker: a spurious release of an unheld id must NOT wake
  // a waiter (which would push into active without freeing a slot, exceeding the cap).
  const l = createForegroundLock(3);
  await l.acquire("r1"); await l.acquire("r2"); await l.acquire("r3");
  let fourthResolved = false;
  const fourth = l.acquire("r4").then((r) => { fourthResolved = true; return r; });
  await new Promise((r) => setImmediate(r));
  strictEqual(fourthResolved, false, "r4 queued at cap");
  // Spurious release of an unheld id — must be a true no-op.
  l.release("not-held");
  await new Promise((r) => setImmediate(r));
  strictEqual(fourthResolved, false, "r4 still queued — no phantom slot granted");
  strictEqual(l.holders().length, 3, "still 3 held — cap not exceeded");
  // A real release lets r4 in.
  l.release("r1");
  const r4 = await fourth;
  ok(r4.ok, "r4 acquires after a REAL release");
  deepStrictEqual(l.holders(), ["r2", "r3", "r4"]);
});