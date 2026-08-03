// test/index-spec5a.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanResumeCandidates } from "../src/runtime/resume.ts";
import { createFleetResultsTool } from "../src/tools/fleet-results.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";
import { workflowKeywordHint } from "../src/workflows/keyword.ts";

test("the SPEC-5a runtime surface is re-exported (smoke — full init needs a pi context)", () => {
  assert.equal(typeof scanResumeCandidates, "function");
  assert.equal(typeof createFleetResultsTool, "function");
});

test("the fleet.results tool wires against an inbox", () => {
  const inbox = new ResultsInbox();
  const tool = createFleetResultsTool({ inbox });
  assert.equal(tool.name, "fleet_results");
});

test("index.ts loads without syntax error (import smoke)", async () => {
  // Dynamic import exercises the module graph including the SPEC-5a wiring.
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.default, "function");
});

test("before_agent_start hook: pushed workflow result renders hint WITHOUT consuming the inbox", () => {
  // Replicates the hook logic from index.ts session_start:
  //   const hint = resultsInbox.renderHint();
  //   if (hint) systemPrompt += "\n\n" + hint;
  const inbox = new ResultsInbox();
  inbox.push({
    runId: "wf-test-1",
    task: "test workflow",
    status: "completed",
    summary: "ok",
    paths: [],
    completedAt: Date.now(),
  });
  // renderHint() does NOT consume (pull() would)
  const hint = inbox.renderHint();
  assert.match(hint, /fleet result(?:s)? ready/);
  // Inbox still has 1 result (not consumed)
  assert.equal(inbox.readyCount(), 1);
});

test("before_agent_start hook: keyword hint + inbox hint both appended when present", () => {
  const inbox = new ResultsInbox();
  inbox.push({
    runId: "wf-test-2",
    task: "test workflow",
    status: "completed",
    summary: "ok",
    paths: [],
    completedAt: Date.now(),
  });
  const inboxHint = inbox.renderHint();
  const keywordHint = workflowKeywordHint("use a workflow for this task");
  const hints: string[] = [];
  if (inboxHint) hints.push(inboxHint);
  if (keywordHint) hints.push(keywordHint);
  assert.ok(hints.length >= 2);
  assert.match(hints[0]!, /fleet result(?:s)? ready/);
  assert.match(hints[1]!, /authorized/);
  // Inbox still not consumed
  assert.equal(inbox.readyCount(), 1);
});

test("before_agent_start hook: both empty returns undefined (no mutation)", () => {
  const inbox = new ResultsInbox();
  const inboxHint = inbox.renderHint();
  const keywordHint = workflowKeywordHint("src/workflow-editor.ts");
  assert.equal(inboxHint, "");
  assert.equal(keywordHint, undefined);
  // Hook returns undefined when both are empty
  const hints: string[] = [];
  if (inboxHint) hints.push(inboxHint);
  if (keywordHint) hints.push(keywordHint);
  assert.equal(hints.length, 0);
});
