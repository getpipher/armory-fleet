// test/turn-budget.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { createTurnBudget } from "../src/engine/turn-budget.ts";

test("not exhausted under max", () => {
  const b = createTurnBudget(3);
  strictEqual(b.consume(), false);
  strictEqual(b.consume(), false);
  strictEqual(b.count(), 2);
});

test("exhausted at max", () => {
  const b = createTurnBudget(2);
  strictEqual(b.consume(), false);
  strictEqual(b.consume(), true);
  strictEqual(b.count(), 2);
});

test("default max is 20", () => {
  const b = createTurnBudget();
  for (let i = 0; i < 19; i++) ok(!b.consume(), `turn ${i + 1} not exhausted`);
  strictEqual(b.consume(), true);
});