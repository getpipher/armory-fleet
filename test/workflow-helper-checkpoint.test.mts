import { test } from "node:test";
import assert from "node:assert/strict";
import { checkpoint } from "../src/workflows/helpers/checkpoint.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(onCheckpoint?: (p: string, o: Record<string, unknown>) => Promise<unknown>) {
  let i = 0;
  return {
    spawn: async () => ({ finalText: "", runId: "fl", status: "completed" as const }),
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-ck-"))),
    runId: "wf-ck",
    onCheckpoint,
    nextCallIndex: () => i++,
  };
}
function cleanup(c: { journal: WorkflowJournal }) { rmSync((c.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("checkpoint: headless 'default' returns opts.default (default true)", async () => {
  const c = ctx();
  try { const r = await checkpoint("ok?", { headless: "default", default: false }, c); assert.equal(r, false); } finally { cleanup(c); }
});

test("checkpoint: headless omitted → default true", async () => {
  const c = ctx();
  try { const r = await checkpoint("ok?", {}, c); assert.equal(r, true); } finally { cleanup(c); }
});

test("checkpoint: headless 'abort' throws (caller aborts the workflow)", async () => {
  const c = ctx();
  try { await assert.rejects(() => checkpoint("ok?", { headless: "abort" }, c), /abort/); } finally { cleanup(c); }
});

test("checkpoint: interactive (onCheckpoint present) resolves via the bridge", async () => {
  const c = ctx(async (_p, _o) => "approved-by-human");
  try { const r = await checkpoint("ok?", { headless: "default" }, c); assert.equal(r, "approved-by-human"); } finally { cleanup(c); }
});
