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