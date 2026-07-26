// test/run-registry.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { RunRegistry, genRunId } from "../src/engine/run-registry.ts";

test("genRunId is fl- prefixed and unique-ish", () => {
  const id = genRunId();
  ok(/^fl-[a-z0-9]+-[a-z0-9]{6}$/.test(id), id);
});

test("add + get a run; list is newest-first", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-1", agent: "g", model: "m", task: "t", track: true, todoId: "td-1", status: "running", startedAt: 1 });
  strictEqual(r.get("fl-1")!.agent, "g");
  strictEqual(r.list().length, 1);
  r.add({ runId: "fl-2", agent: "g", model: "m", task: "t2", track: true, todoId: null, status: "running", startedAt: 2 });
  strictEqual(r.list()[0]!.runId, "fl-2");
});

test("update patches status + endedAt + resultSummary", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-3", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1 });
  r.update("fl-3", { status: "completed", endedAt: 99, resultSummary: "done" });
  strictEqual(r.get("fl-3")!.status, "completed");
  strictEqual(r.get("fl-3")!.endedAt, 99);
});

test("subscribe fires on add + update; unsubscribe stops them", () => {
  const r = new RunRegistry();
  const calls: string[] = [];
  const unsub = r.subscribe(() => calls.push("x"));
  r.add({ runId: "fl-a", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1 });
  strictEqual(calls.length, 1, "add fires");
  r.update("fl-a", { status: "completed", endedAt: 2 });
  strictEqual(calls.length, 2, "update fires");
  unsub();
  r.add({ runId: "fl-b", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 3 });
  strictEqual(calls.length, 2, "no fire after unsubscribe");
});

test("list/get do not fire subscribers (read-only)", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-r", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1 });
  const calls: string[] = [];
  r.subscribe(() => calls.push("x"));
  r.list();
  r.get("fl-r");
  strictEqual(calls.length, 0, "reads do not fire");
});

test("resumedFrom/forkedFrom survive add + update (additive optional fields)", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-r1", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1, resumedFrom: "fl-prior" });
  strictEqual(r.get("fl-r1")!.resumedFrom, "fl-prior");
  r.update("fl-r1", { forkedFrom: "fl-other" });
  strictEqual(r.get("fl-r1")!.forkedFrom, "fl-other");
  strictEqual(r.get("fl-r1")!.resumedFrom, "fl-prior", "update did not clobber resumedFrom");
});