import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowRunDeps } from "../src/workflows/runner.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(isGit: boolean, spawnCalls: { prompt: string }[] = []): WorkflowRunDeps {
  return {
    spawn: async (p: string) => { spawnCalls.push({ prompt: p }); return { finalText: "ok", runId: "fl", status: "completed" as const }; },
    worktree: { isGitRepo: () => isGit, create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-iso-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
  } as WorkflowRunDeps;
}
function cleanup(d: WorkflowRunDeps) { rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("agent({isolation:'worktree'}) in non-git → fail-fast returns null (no spawn, no retry)", async () => {
  const calls: { prompt: string }[] = [];
  const d = deps(false, calls);
  try {
    const script = "module.exports = (async () => { const a = await agent('edit me', { isolation: 'worktree' }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto", agentRetries: 3 }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, null); // fail-fast → null
    assert.equal(calls.length, 0); // NO spawn (deterministic env error, not retryable)
  } finally { cleanup(d); }
});

test("agent({isolation:'worktree'}) in git → worktree created + removed", async () => {
  const wtCreated: string[] = [];
  const wtRemoved: string[] = [];
  const d = deps(true);
  (d.worktree as unknown as { create: (id: string) => { path: string; branch: string }; removeWorktree: (id: string) => void }).create = (id) => { wtCreated.push(id); return { path: `/tmp/wt-${id}`, branch: `fleet/${id}` }; };
  (d.worktree as unknown as { removeWorktree: (id: string) => void }).removeWorktree = (id) => { wtRemoved.push(id); };
  try {
    const script = "module.exports = (async () => { const a = await agent('edit me', { isolation: 'worktree' }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, "ok");
    assert.equal(wtCreated.length, 1);
    assert.equal(wtRemoved.length, 1);
  } finally { cleanup(d); }
});

test("default agent() → in-place (no worktree)", async () => {
  const wtCreated: string[] = [];
  const d = deps(true);
  (d.worktree as unknown as { create: (id: string) => { path: string; branch: string } }).create = (id) => { wtCreated.push(id); return { path: `/tmp/wt-${id}`, branch: `fleet/${id}` }; };
  try {
    const script = "module.exports = (async () => { const a = await agent('plain'); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(wtCreated.length, 0); // no worktree for default in-place agent()
  } finally { cleanup(d); }
});
