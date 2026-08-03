import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRealm, compileWorkflowScript, type RealmDeps } from "../src/workflows/vm-realm.ts";

function fakeDeps(overrides: Partial<RealmDeps> = {}): RealmDeps {
  const base: RealmDeps = {
    agent: async () => "agent-result",
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items, ...stages) => {
      let cur = items;
      for (const stage of stages) cur = await Promise.all(cur.map((i) => stage(i)));
      return cur;
    },
    phase: () => {},
    workflow: async () => "child-result",
    verify: async () => ({ real: true, realCount: 1, total: 1, votes: [] }),
    judgePanel: async () => ({ index: 0, attempt: null, score: 1, judgments: [] }),
    loopUntilDry: async () => [],
    completenessCheck: async () => ({ complete: true }),
    gate: async () => ({ ok: true, value: null, attempts: 1 }),
    retry: async (thunk) => thunk(0),
    checkpoint: async () => true,
    log: () => {},
    args: { x: 1 },
    cwd: "/tmp/fake",
    budget: { total: 10000, spent: () => 0, remaining: () => 10000 },
  };
  return { ...base, ...overrides } as RealmDeps;
}

test("injected globals are available in the realm", async () => {
  const deps = fakeDeps();
  const ctx = buildRealm(deps);
  const script = compileWorkflowScript("module.exports = { args: args, cwd: cwd, pc: process.cwd() }");
  const ns = script.runInContext(ctx) as { args: unknown; cwd: string; pc: string };
  assert.deepEqual(ns.args, { x: 1 });
  assert.equal(ns.cwd, "/tmp/fake");
  assert.equal(ns.pc, "/tmp/fake");
});

test("agent/parallel/pipeline/phase/workflow globals are callable", async () => {
  const deps = fakeDeps({ agent: async (p) => `got:${p}`, workflow: async (n) => `child:${n}` });
  const ctx = buildRealm(deps);
  const script = compileWorkflowScript(`
    module.exports = (async () => {
      const a = await agent('hi');
      const arr = await parallel([() => agent('x'), () => agent('y')]);
      const pipe = await pipeline([1,2], (n) => agent('n'+n));
      phase('Review');
      const w = await workflow('child');
      return { a, arr, pipe, w };
    })();
  `);
  const result = await (script.runInContext(ctx) as Promise<{ a: string; arr: string[]; pipe: string[]; w: string }>);
  assert.equal(result.a, "got:hi");
  assert.deepEqual(result.arr, ["got:x", "got:y"]);
  assert.deepEqual(result.pipe, ["got:n1", "got:n2"]);
  assert.equal(result.w, "child:child");
});

test("stripped: Date.now throws ReferenceError", () => {
  const ctx = buildRealm(fakeDeps());
  const script = compileWorkflowScript("module.exports = Date.now()");
  assert.throws(() => script.runInContext(ctx), (e: Error) => e instanceof ReferenceError || /Date is not defined/.test(e.message));
});

test("stripped: Math.random throws ReferenceError", () => {
  const ctx = buildRealm(fakeDeps());
  const script = compileWorkflowScript("module.exports = Math.random()");
  assert.throws(() => script.runInContext(ctx), /Math is not defined/);
});

test("stripped: require throws ReferenceError", () => {
  const ctx = buildRealm(fakeDeps());
  const script = compileWorkflowScript("module.exports = require('fs')");
  assert.throws(() => script.runInContext(ctx), /require is not defined/);
});

test("stripped: no setTimeout/setInterval", () => {
  const ctx = buildRealm(fakeDeps());
  const script = compileWorkflowScript("module.exports = setTimeout");
  assert.throws(() => script.runInContext(ctx), /setTimeout is not defined/);
});

test("helpers are callable: verify/judgePanel/loopUntilDry/checkpoint", async () => {
  const deps = fakeDeps({
    verify: async () => ({ real: false, realCount: 0, total: 2, votes: [] }),
    judgePanel: async () => ({ index: 1, attempt: "b", score: 9, judgments: [] }),
    loopUntilDry: async () => ["a", "b"],
    checkpoint: async () => "approved",
  });
  const ctx = buildRealm(deps);
  const script = compileWorkflowScript(`
    module.exports = (async () => {
      const v = await verify('item');
      const j = await judgePanel(['a','b']);
      const l = await loopUntilDry({ round: () => [] });
      const c = await checkpoint('ok?');
      return { v, j, l, c };
    })();
  `);
  const r = await (script.runInContext(ctx) as Promise<{ v: unknown; j: unknown; l: unknown[]; c: string }>);
  assert.deepEqual(r.v, { real: false, realCount: 0, total: 2, votes: [] });
  assert.equal((r.j as { index: number }).index, 1);
  assert.deepEqual(r.l, ["a", "b"]);
  assert.equal(r.c, "approved");
});

test("budget is accessible and reports remaining", () => {
  const ctx = buildRealm(fakeDeps({ budget: { total: 500, spent: () => 100, remaining: () => 400 } }));
  const script = compileWorkflowScript("module.exports = { total: budget.total, remaining: budget.remaining() }");
  const ns = script.runInContext(ctx) as { total: number; remaining: number };
  assert.equal(ns.total, 500);
  assert.equal(ns.remaining, 400);
});

test("log is a no-op-callable function", () => {
  let captured: unknown[] = [];
  const ctx = buildRealm(fakeDeps({ log: (m) => { captured.push(m); } }));
  const script = compileWorkflowScript("log('hello'); module.exports = 1");
  script.runInContext(ctx);
  assert.deepEqual(captured, ["hello"]);
});
