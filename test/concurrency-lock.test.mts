// test/concurrency-lock.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";

test("first acquire succeeds", () => {
  const l = createSingleSlotLock();
  ok(l.tryAcquire("fl-1"));
  strictEqual(l.current(), "fl-1");
});

test("second acquire fails with the running id held", () => {
  const l = createSingleSlotLock();
  l.tryAcquire("fl-1");
  strictEqual(l.tryAcquire("fl-2"), false);
  strictEqual(l.current(), "fl-1");
});

test("release frees the slot", () => {
  const l = createSingleSlotLock();
  l.tryAcquire("fl-1");
  l.release();
  ok(l.tryAcquire("fl-2"));
});