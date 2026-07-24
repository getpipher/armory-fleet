// test/fleet-results.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetResultsTool } from "../src/tools/fleet-results.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";

test("fleet.results() with no arg returns all ready + marks delivered", async () => {
  const inbox = new ResultsInbox();
  inbox.push({ runId: "fl-1", task: "t1", status: "completed", summary: "s", paths: [], branch: "fleet/fl-1", completedAt: 1 });
  inbox.push({ runId: "fl-2", task: "t2", status: "completed", summary: "s", paths: [], branch: "fleet/fl-2", completedAt: 2 });
  const tool = createFleetResultsTool({ inbox });
  const res: any = await tool.execute("callid", {});
  assert.equal(res.details.results.length, 2);
  assert.equal(inbox.readyCount(), 0);
});

test("fleet.results({ runId }) returns that result + marks delivered", async () => {
  const inbox = new ResultsInbox();
  inbox.push({ runId: "fl-3", task: "t3", status: "completed", summary: "s", paths: ["a.md"], branch: "fleet/fl-3", completedAt: 3 });
  const tool = createFleetResultsTool({ inbox });
  const res: any = await tool.execute("callid", { runId: "fl-3" });
  assert.equal(res.details.results.length, 1);
  assert.equal(res.details.results[0]!.runId, "fl-3");
  assert.equal(inbox.readyCount(), 0);
});

test("fleet.results() returns empty array when nothing ready", async () => {
  const inbox = new ResultsInbox();
  const tool = createFleetResultsTool({ inbox });
  const res: any = await tool.execute("callid", {});
  assert.equal(res.details.results.length, 0);
});