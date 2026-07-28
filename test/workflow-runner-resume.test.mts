import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowRunDeps } from "../src/workflows/runner.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(): WorkflowRunDeps {
  let n = 0;
  return {
    spawn: async (p: string) => ({ finalText: `R${n++}:${p}`, runId: `fl-${n}`, status: "completed" as const, costTotal: 0.01, tokenTotal: 100 }),
    worktree: { isGitRepo: () => true, create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-res-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
  } as WorkflowRunDeps;
}
function cleanup(d: WorkflowRunDeps) { rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("resume: unchanged prefix reused from cache (no spawn)", async () => {
  const d = deps();
  try {
    const script = "module.exports = (async () => { const a = await agent('first'); const b = await agent('second'); return [a, b]; })()";
    const r1 = await runWorkflow("x", { script, mode: "auto" }, d);
    // Now resume with the SAME script — both calls should replay from cache (0 new spawns).
    let spawned = 0;
    const d2 = { ...d, spawn: async (p: string) => { spawned++; return { finalText: `NEW:${p}`, runId: "fl-new", status: "completed" as const }; } } as WorkflowRunDeps;
    d2.journal = d.journal; // same journal → same runId's cache
    const r2 = await runWorkflow("x", { script, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(spawned, 0, "no spawns expected on full cache reuse");
    assert.equal(r2.status, "completed");
  } finally { cleanup(d); }
});

test("resume: edited suffix re-runs only the edited call + after", async () => {
  const d = deps();
  try {
    const script1 = "module.exports = (async () => { const a = await agent('A'); const b = await agent('B'); return [a,b]; })()";
    const r1 = await runWorkflow("x", { script: script1, mode: "auto" }, d);
    // Edit the SECOND call; first should reuse cache.
    const script2 = "module.exports = (async () => { const a = await agent('A'); const b = await agent('B-EDITED'); return [a,b]; })()";
    let spawnedPrompts: string[] = [];
    const d2 = { ...d, spawn: async (p: string) => { spawnedPrompts.push(p); return { finalText: `R:${p}`, runId: "fl-e", status: "completed" as const }; } } as WorkflowRunDeps;
    d2.journal = d.journal;
    const r2 = await runWorkflow("x", { script: script2, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(spawnedPrompts.length, 1);
    assert.equal(spawnedPrompts[0], "B-EDITED");
    assert.equal(r2.status, "completed");
  } finally { cleanup(d); }
});

test("resume: shorter script ignores extra cache entries", async () => {
  const d = deps();
  try {
    const s1 = "module.exports = (async () => { const a = await agent('A'); const b = await agent('B'); return [a,b]; })()";
    const r1 = await runWorkflow("x", { script: s1, mode: "auto" }, d);
    const s2 = "module.exports = (async () => { const a = await agent('A'); return a; })()";
    let spawned = 0;
    const d2 = { ...d, spawn: async () => { spawned++; return { finalText: "X", runId: "fl", status: "completed" as const }; } } as WorkflowRunDeps;
    d2.journal = d.journal;
    const r2 = await runWorkflow("x", { script: s2, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(spawned, 0); // A reused from cache; B's cache ignored
    assert.equal(r2.status, "completed");
  } finally { cleanup(d); }
});

test("resume: reordered calls invalidate from first mismatch (all re-run)", async () => {
  const d = deps();
  try {
    const s1 = "module.exports = (async () => { const a = await agent('A'); const b = await agent('B'); return [a,b]; })()";
    const r1 = await runWorkflow("x", { script: s1, mode: "auto" }, d);
    const s2 = "module.exports = (async () => { const a = await agent('B'); const b = await agent('A'); return [a,b]; })()";
    let spawned = 0;
    const d2 = { ...d, spawn: async () => { spawned++; return { finalText: "X", runId: "fl", status: "completed" as const }; } } as WorkflowRunDeps;
    d2.journal = d.journal;
    const r2 = await runWorkflow("x", { script: s2, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(spawned, 2); // B doesn't match A at index 0 → mismatch → both re-run
    assert.equal(r2.status, "completed");
  } finally { cleanup(d); }
});

test("resume: missing prior journal → fresh run (no crash)", async () => {
  const d = deps();
  try {
    let spawned = 0;
    const d2 = { ...d, spawn: async () => { spawned++; return { finalText: "X", runId: "fl", status: "completed" as const }; } } as WorkflowRunDeps;
    const r = await runWorkflow("x", { script: "module.exports = (async () => await agent('A'))()", mode: "auto", resumeFromRunId: "never-existed" }, d2);
    assert.equal(spawned, 1);
    assert.equal(r.status, "completed");
  } finally { cleanup(d); }
});

test("resume: checkpoint unchanged → cached response returned (no re-prompt)", async () => {
  const d = deps();
  try {
    const script = "module.exports = (async () => { const v = await checkpoint('ok?', { headless: 'default', default: true }); return v; })()";
    const r1 = await runWorkflow("x", { script, mode: "auto" }, d);
    // Resume with same script — checkpoint should be cached, onCheckpoint NOT called.
    let checkpointCalls = 0;
    const d2: WorkflowRunDeps = {
      ...d,
      onCheckpoint: async () => { checkpointCalls++; return "re-prompted"; },
    };
    d2.journal = d.journal;
    const r2 = await runWorkflow("x", { script, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(checkpointCalls, 0, "onCheckpoint should NOT be called on cache hit");
    assert.equal(r2.status, "completed");
    assert.equal(r2.result, true); // cached default value
  } finally { cleanup(d); }
});

test("resume: checkpoint opts changed → re-prompts", async () => {
  const d = deps();
  try {
    const script1 = "module.exports = (async () => { const v = await checkpoint('ok?', { headless: 'default', default: true }); return v; })()";
    const r1 = await runWorkflow("x", { script: script1, mode: "auto" }, d);
    // Resume with changed default — checkpoint opts differ, should re-prompt.
    let checkpointCalls = 0;
    const script2 = "module.exports = (async () => { const v = await checkpoint('ok?', { headless: 'default', default: false }); return v; })()";
    const d2: WorkflowRunDeps = {
      ...d,
      onCheckpoint: async () => { checkpointCalls++; return "re-prompted"; },
    };
    d2.journal = d.journal;
    const r2 = await runWorkflow("x", { script: script2, mode: "auto", resumeFromRunId: r1.runId }, d2);
    assert.equal(checkpointCalls, 1, "onCheckpoint SHOULD be called on cache miss (opts changed)");
    assert.equal(r2.status, "completed");
    assert.equal(r2.result, "re-prompted");
  } finally { cleanup(d); }
});