import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowRunDeps } from "../src/workflows/runner.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(overrides: Partial<WorkflowRunDeps> = {}): WorkflowRunDeps {
  return {
    spawn: async (prompt) => ({ finalText: `spawned:${prompt.slice(0, 10)}`, runId: "fl-" + Math.random().toString(36).slice(2, 8), status: "completed" as const, costTotal: 0.01, tokenTotal: 100 }),
    worktree: { isGitRepo: () => true, create: (id) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-run-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
    ...overrides,
  } as WorkflowRunDeps;
}
function cleanup(d: WorkflowRunDeps) { rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("runWorkflow: simple script returning a value", async () => {
  const d = deps();
  try {
    const r = await runWorkflow("module.exports = 42", { script: "module.exports = 42", mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, 42);
  } finally { cleanup(d); }
});

test("runWorkflow: agent() call spawns + journals + returns text", async () => {
  const d = deps({ spawn: async (p) => ({ finalText: `result:${p}`, runId: "fl-a", status: "completed", costTotal: 0.02, tokenTotal: 200 }) });
  try {
    const r = await runWorkflow("x", { script: "module.exports = (async () => await agent('hello'))()", mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, "result:hello");
    const events = d.journal.replay(r.runId);
    assert.ok(events.some((e) => e.type === "agent:call"));
    assert.ok(events.some((e) => e.type === "agent:result"));
  } finally { cleanup(d); }
});

test("runWorkflow: parallel preserves order", async () => {
  const d = deps();
  try {
    const script = "module.exports = (async () => await parallel([() => agent('x'), () => agent('y'), () => agent('z')]))()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.result, ["spawned:x", "spawned:y", "spawned:z"]);
  } finally { cleanup(d); }
});

test("runWorkflow: pipeline chains stages", async () => {
  const d = deps({ spawn: async (p) => ({ finalText: p.toUpperCase(), runId: "fl-p", status: "completed" }) });
  try {
    const script = "module.exports = (async () => await pipeline(['a','b'], (x) => agent(x)))()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.deepEqual(r.result, ["A", "B"]);
  } finally { cleanup(d); }
});

test("runWorkflow: phase() advances current phase + labels agent calls", async () => {
  const d = deps();
  try {
    const script = `module.exports = (async () => { phase('Scan'); const a = await agent('list'); phase('Review'); const b = await agent('check'); return [a, b]; })()`;
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.phases.length, 2);
    assert.equal(r.phases[0]!.title, "Scan");
    assert.equal(r.phases[1]!.title, "Review");
  } finally { cleanup(d); }
});

test("runWorkflow: script throws → wf:aborted", async () => {
  const d = deps();
  try {
    const r = await runWorkflow("x", { script: "module.exports = (async () => { throw new Error('boom') })()", mode: "auto" }, d);
    assert.equal(r.status, "aborted");
    assert.match(r.error ?? "", /boom/);
  } finally { cleanup(d); }
});

test("runWorkflow: stripped global (Date.now) → aborted", async () => {
  const d = deps();
  try {
    const r = await runWorkflow("x", { script: "module.exports = Date.now()", mode: "auto" }, d);
    assert.equal(r.status, "aborted");
    assert.match(r.error ?? "", /Date is not defined/i);
  } finally { cleanup(d); }
});

test("runWorkflow: child agent crash → agent() returns null (script continues)", async () => {
  const d = deps({ spawn: async () => ({ finalText: "", runId: "fl-crash", status: "failed", costTotal: 0, tokenTotal: 0 }) });
  try {
    const script = "module.exports = (async () => { const a = await agent('x'); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, null);
  } finally { cleanup(d); }
});

test("runWorkflow: wf:started + wf:completed journaled", async () => {
  const d = deps();
  try {
    const r = await runWorkflow("x", { script: "module.exports = 1", mode: "auto" }, d);
    const events = d.journal.replay(r.runId);
    assert.equal(events[0]!.type, "wf:started");
    assert.equal(events[events.length - 1]!.type, "wf:completed");
  } finally { cleanup(d); }
});

test("runWorkflow: maxAgents exceeded → aborted", async () => {
  const d = deps();
  try {
    const script = "module.exports = (async () => { for (let i = 0; i < 5; i++) await agent('x'); })()";
    const r = await runWorkflow("x", { script, mode: "auto", maxAgents: 3 }, d);
    assert.equal(r.status, "aborted");
    assert.match(r.error ?? "", /max agents/i);
  } finally { cleanup(d); }
});

test("runWorkflow: recursion depth exceeded → aborted", async () => {
  const d = deps({ resolveWorkflow: () => "module.exports = (async () => await workflow('recur'))()" });
  try {
    const r = await runWorkflow("x", { script: "module.exports = (async () => await workflow('recur'))()", mode: "auto", maxRecursionDepth: 1 }, d);
    assert.equal(r.status, "aborted");
    assert.match(r.error ?? "", /recursion depth exceeded/);
  } finally { cleanup(d); }
});

test("runWorkflow: helper call journals helper:call + helper:result", async () => {
  const d = deps({ spawn: async () => ({ finalText: "real", runId: "fl-h", status: "completed" }) });
  try {
    const script = "module.exports = (async () => await verify('item', { reviewers: 1 }))()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    const events = d.journal.replay(r.runId);
    assert.ok(events.some((e) => e.type === "helper:call" && (e as { name: string }).name === "verify"), "missing helper:call for verify");
    assert.ok(events.some((e) => e.type === "helper:result" && (e as { name: string }).name === "verify"), "missing helper:result for verify");
  } finally { cleanup(d); }
});
