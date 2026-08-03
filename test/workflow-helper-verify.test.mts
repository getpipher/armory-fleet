import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/workflows/helpers/verify.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(votes: string[]) {
  let i = 0; let ci = 0;
  return {
    spawn: async () => ({ finalText: votes[i++] ?? "real", runId: "fl-v", status: "completed" as const }),
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-v-"))),
    runId: "wf-verify",
    nextCallIndex: () => ci++,
  };
}
function cleanup(c: { journal: WorkflowJournal }) { rmSync((c.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("verify: majority real → real:true", async () => {
  const c = ctx(["real","real"]);
  try { const r = await verify("item", { reviewers: 2 }, c); assert.equal(r.real, true); assert.equal(r.total, 2); assert.equal(r.realCount, 2); } finally { cleanup(c); }
});

test("verify: threshold 0.5, 1/2 real → real:true", async () => {
  const c = ctx(["real","fake"]);
  try { const r = await verify("item", { reviewers: 2, threshold: 0.5 }, c); assert.equal(r.real, true); assert.equal(r.realCount, 1); } finally { cleanup(c); }
});

test("verify: below threshold → real:false", async () => {
  const c = ctx(["fake","fake"]);
  try { const r = await verify("item", { reviewers: 2, threshold: 0.6 }, c); assert.equal(r.real, false); assert.equal(r.realCount, 0); } finally { cleanup(c); }
});

test("verify: reviewer crash → counts as not-real vote (no abort)", async () => {
  // First reviewer crashes (null), second succeeds ("real"); threshold 0.6 so 1/2=0.5 < 0.6 → real:false.
  let calls = 0;
  const c = { ...ctx(["real"]), spawn: async () => { calls++; return calls === 1 ? null : { finalText: "real", runId: "fl-v", status: "completed" as const }; } } as unknown as ReturnType<typeof ctx>;
  try { const r = await verify("item", { reviewers: 2, threshold: 0.6 }, c); assert.equal(r.total, 2); assert.equal(r.realCount, 1); assert.equal(r.real, false); } finally { cleanup(c); }
});

test("verify: lens scopes the prompt (smoke — check spawn received lens)", async () => {
  let captured: string[] = [];
  const c = { ...ctx(["real","real"]), spawn: async (p: string) => { captured.push(p); return { finalText: "real", runId: "fl", status: "completed" as const }; } } as unknown as ReturnType<typeof ctx>;
  try { await verify("item", { reviewers: 2, lens: "security" }, c); assert.ok(captured.every((p) => p.includes("security"))); } finally { cleanup(c); }
});
