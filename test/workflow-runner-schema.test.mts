import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowRunDeps } from "../src/workflows/runner.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(seq: string[]): WorkflowRunDeps {
  let i = 0;
  return {
    spawn: async () => ({ finalText: seq[i++] ?? "{}", runId: "fl-s", status: "completed" as const }),
    worktree: { isGitRepo: () => true, create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-sch-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
  } as WorkflowRunDeps;
}
function cleanup(d: WorkflowRunDeps) { rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("agent({schema}) valid on first try → returns parsed result", async () => {
  const d = deps(['{"name":"x","age":5}']);
  try {
    const script = "module.exports = (async () => { const a = await agent('p', { schema: { type: 'object', required: ['name','age'], properties: { name: { type: 'string' }, age: { type: 'number' } } } }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.result, { name: "x", age: 5 });
  } finally { cleanup(d); }
});

test("agent({schema}) mismatch → re-spawn (1 per retry); valid on 2nd → returns", async () => {
  let spawnCount = 0;
  const seq = ['{"name":"x"}', '{"name":"x","age":5}'];
  const d = deps(seq);
  (d as unknown as { spawn: () => Promise<unknown> }).spawn = async () => { spawnCount++; return { finalText: seq[spawnCount - 1], runId: "fl", status: "completed" }; };
  try {
    const script = "module.exports = (async () => { const a = await agent('p', { schema: { type: 'object', required: ['name','age'] }, retries: 2 }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(spawnCount, 2);
    assert.deepEqual(r.result, { name: "x", age: 5 });
  } finally { cleanup(d); }
});

test("agent({schema}) retries exhausted → returns null", async () => {
  const d = deps(['{"name":"x"}', '{"name":"x"}', '{"name":"x"}']);
  try {
    const script = "module.exports = (async () => { const a = await agent('p', { schema: { type: 'object', required: ['name','age'] }, retries: 2 }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, null);
  } finally { cleanup(d); }
});
