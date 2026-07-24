// test/concurrency-pool.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyPool } from "../src/runtime/concurrency-pool.ts";

test("withSlot runs up to N in parallel; N+1th waits for a release", async () => {
  const pool = new ConcurrencyPool(2);
  let active = 0;
  let maxActive = 0;
  const task = async (label: string): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return label;
  };
  const all = await Promise.all([
    pool.withSlot(() => task("a")),
    pool.withSlot(() => task("b")),
    pool.withSlot(() => task("c")),
    pool.withSlot(() => task("d")),
  ]);
  assert.deepEqual(all, ["a", "b", "c", "d"]);
  assert.ok(maxActive <= 2, `maxActive=${maxActive} exceeded cap 2`);
  assert.equal(pool.busy(), 0);
  assert.equal(pool.queued(), 0);
});

test("default cap is 3", async () => {
  const pool = new ConcurrencyPool();
  let active = 0;
  let maxActive = 0;
  const task = async (l: string) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; return l; };
  await Promise.all([1, 2, 3, 4].map((i) => pool.withSlot(() => task(`t${i}`))));
  assert.ok(maxActive <= 3, `maxActive=${maxActive} exceeded default cap 3`);
});

test("busy + queued counts reflect state", async () => {
  const pool = new ConcurrencyPool(1);
  let release1!: () => void;
  const p1 = pool.withSlot(() => new Promise<string>((r) => { release1 = () => r("a"); }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pool.busy(), 1);
  const p2 = pool.withSlot(() => new Promise<string>((r) => r("b")));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pool.queued(), 1);
  release1();
  assert.equal(await p1, "a");
  assert.equal(await p2, "b");
  assert.equal(pool.busy(), 0);
});