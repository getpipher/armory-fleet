import { test } from "node:test";
import assert from "node:assert/strict";
import { completenessCheck } from "../src/workflows/helpers/completeness-check.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(finalText: string) { let i = 0; return { spawn: async () => ({ finalText, runId: "fl-cc", status: "completed" as const }), journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-cc-"))), runId: "wf-cc", nextCallIndex: () => i++ }; }
function cleanup(c: { journal: WorkflowJournal }) { rmSync((c.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("completenessCheck returns complete:true when agent says complete", async () => {
  const c = ctx('{"complete":true}');
  try { const r = await completenessCheck({ task: "list files" }, ["a", "b"], c); assert.deepEqual(r, { complete: true }); } finally { cleanup(c); }
});

test("completenessCheck returns complete:false + missing when agent reports gaps", async () => {
  const c = ctx('{"complete":false,"missing":["c"]}');
  try { const r = await completenessCheck({}, ["a","b"], c); assert.deepEqual(r, { complete: false, missing: ["c"] }); } finally { cleanup(c); }
});

test("completenessCheck returns null when spawn fails (agent cant judge)", async () => {
  const c = { ...ctx(""), spawn: async () => null } as unknown as ReturnType<typeof ctx>;
  try { const r = await completenessCheck({}, [], c); assert.equal(r, null); } finally { cleanup(c); }
});

test("completenessCheck returns null on malformed agent JSON", async () => {
  const c = ctx("not json");
  try { const r = await completenessCheck({}, [], c); assert.equal(r, null); } finally { cleanup(c); }
});
