import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowRunDeps } from "../src/workflows/runner.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(overrides: Partial<WorkflowRunDeps> = {}): WorkflowRunDeps {
  return {
    spawn: async (p: string) => ({ finalText: `spawned:${p}`, runId: "fl", status: "completed" as const }),
    worktree: { isGitRepo: () => true, create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-lc-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
    ...overrides,
  } as WorkflowRunDeps;
}
function cleanup(d: WorkflowRunDeps) { rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("agent({lifecycle:'default'}) runs runLifecycle with the prompt as task", async () => {
  let lcArgs: { task: string; name: string; mode: string } | null = null;
  const d = deps({ runLifecycle: async (task, name, o) => { lcArgs = { task, name, mode: o.mode }; return { status: "completed", finalText: "LC-RESULT", costTotal: 0.5, tokenTotal: 1000 }; } });
  try {
    const script = "module.exports = (async () => { const a = await agent('audit the routes', { lifecycle: 'default' }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, "LC-RESULT");
    assert.equal(lcArgs!.task, "audit the routes");
    assert.equal(lcArgs!.name, "default");
  } finally { cleanup(d); }
});

test("agent({lifecycle}) failure → step returns null", async () => {
  const d = deps({ runLifecycle: async () => ({ status: "failed", finalText: "", error: "lc failed" }) });
  try {
    const script = "module.exports = (async () => { const a = await agent('x', { lifecycle: 'default' }); return a; })()";
    const r = await runWorkflow("x", { script, mode: "auto" }, d);
    assert.equal(r.status, "completed");
    assert.equal(r.result, null);
  } finally { cleanup(d); }
});

test("agent({lifecycle}) + isolation:'worktree' threads worktreePath into runLifecycle", async () => {
  let worktreePathSeen: string | undefined;
  const d = deps({ runLifecycle: async (_t, _n, o) => { worktreePathSeen = o.worktreePath; return { status: "completed", finalText: "ok" }; } });
  try {
    const script = "module.exports = (async () => { const a = await agent('x', { lifecycle: 'default', isolation: 'worktree' }); return a; })()";
    await runWorkflow("x", { script, mode: "auto" }, d);
    assert.ok(worktreePathSeen, "worktreePath threaded into runLifecycle");
  } finally { cleanup(d);
  }
});