import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePanel } from "../src/workflows/helpers/judge-panel.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(scores: number[][]) {
  let round = 0; let within = 0; let ci = 0;
  // scores[round] is the per-attempt score list judge `round` returns for all attempts
  return {
    spawn: async () => {
      const r = scores[round] ?? [];
      const s = r[within++] ?? r[r.length - 1] ?? 5;
      if (within >= (scores[round]?.length ?? 0)) { within = 0; round++; }
      return { finalText: `{"score":${s},"reason":"ok"}`, runId: "fl-jp", status: "completed" as const };
    },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-jp-"))),
    runId: "wf-jp",
    nextCallIndex: () => ci++,
  };
}
function cleanup(c: { journal: WorkflowJournal }) { rmSync((c.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("judgePanel returns the highest-scoring attempt", async () => {
  // 2 attempts, 1 judge; scores: attempt0=5, attempt1=9
  const c = ctx([[5, 9]]);
  try { const r = await judgePanel(["a", "b"], { judges: 1 }, c); assert.ok(r); assert.equal(r!.index, 1); assert.equal(r!.score, 9); } finally { cleanup(c); }
});

test("judgePanel: 3 judges score every attempt; highest average wins", async () => {
  // 2 attempts, 3 judges; attempt0 avg = (7+7+7)/3=7; attempt1 avg = (8+8+8)/3=8 → attempt1 wins
  const c = ctx([[7,8],[7,8],[7,8]]);
  try { const r = await judgePanel(["a", "b"], { judges: 3 }, c); assert.ok(r); assert.equal(r!.index, 1); } finally { cleanup(c); }
});

test("judgePanel returns undefined on empty attempts", async () => {
  const c = ctx([]);
  try { const r = await judgePanel([], { judges: 1 }, c); assert.equal(r, undefined); } finally { cleanup(c); }
});
