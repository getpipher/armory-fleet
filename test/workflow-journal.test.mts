// SPEC-6-3 — tests for the per-workflow positional-call-index journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowJournal } from "../src/workflows/journal.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "wf-journal-"));
}

test("append + replay round-trips all event types", () => {
  const dir = freshDir();
  try {
    const j = new WorkflowJournal(dir);
    const runId = "wf-test1";
    j.append(runId, { type: "wf:started", runId, script: "export const meta={name:'t'};agent('hi')", args: { x: 1 }, phases: [{ title: "Scan" }], ts: 1000 });
    j.append(runId, { type: "agent:call", callIndex: 0, label: "agent 0", phase: "Scan", prompt: "hi", opts: { tier: "small" }, ts: 1001 });
    j.append(runId, { type: "agent:result", callIndex: 0, childRunId: "fl-child0", result: "done", status: "completed", costTotal: 0.01, tokenTotal: 500, ts: 1002 });
    j.append(runId, { type: "helper:call", callIndex: 1, name: "verify", args: { item: "x" }, ts: 1003 });
    j.append(runId, { type: "helper:result", callIndex: 1, name: "verify", result: { real: true }, ts: 1004 });
    j.append(runId, { type: "checkpoint", callIndex: 2, prompt: "ok?", response: true, ts: 1005 });
    j.append(runId, { type: "wf:completed", runId, result: "final", costTotal: 0.01, tokenTotal: 500, ts: 1006 });

    const events = j.replay(runId);
    assert.equal(events.length, 7);
    assert.equal(events[0]!.type, "wf:started");
    assert.equal((events[0] as { phases?: { title: string }[] }).phases?.[0]?.title, "Scan");
    assert.equal(events[6]!.type, "wf:completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanNonTerminal returns runIds whose last event is non-terminal", () => {
  const dir = freshDir();
  try {
    const j = new WorkflowJournal(dir);
    j.append("wf-a", { type: "wf:started", runId: "wf-a", script: "x", ts: 1 });
    j.append("wf-a", { type: "agent:call", callIndex: 0, label: "a0", phase: "p", prompt: "x", opts: {}, ts: 2 });
    // wf-a has no terminal event → non-terminal
    j.append("wf-b", { type: "wf:started", runId: "wf-b", script: "y", ts: 3 });
    j.append("wf-b", { type: "wf:completed", runId: "wf-b", result: null, ts: 4 });
    // wf-b is terminal
    const ids = j.scanNonTerminal();
    assert.deepEqual([...ids].sort(), ["wf-a"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanNonTerminal on missing dir returns []", () => {
  const j = new WorkflowJournal(join(tmpdir(), "does-not-exist-wf-" + Date.now()));
  assert.deepEqual(j.scanNonTerminal(), []);
});

test("replay on missing file returns []", () => {
  const dir = freshDir();
  try {
    const j = new WorkflowJournal(dir);
    assert.deepEqual(j.replay("never"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replay discards a partial last line (crash mid-append)", () => {
  const dir = freshDir();
  try {
    const j = new WorkflowJournal(dir);
    j.append("wf-c", { type: "wf:started", runId: "wf-c", script: "z", ts: 1 });
    // Simulate a crash: append a partial line directly
    appendFileSync(join(dir, "wf-c.jsonl"), '{"type":"agent:call","callInd'); // truncated
    const events = j.replay("wf-c");
    assert.equal(events.length, 1); // the valid wf:started only; partial line discarded
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
