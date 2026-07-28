import { test } from "node:test";
import assert from "node:assert/strict";
import { loopUntilDry } from "../src/workflows/helpers/loop-until-dry.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(finalTexts: string[]) {
  let i = 0; let ci = 0;
  return {
    spawn: async () => ({ finalText: finalTexts[i++] ?? "[]", runId: "fl-lud", status: "completed" as const }),
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-lud-"))),
    runId: "wf-lud",
    nextCallIndex: () => ci++,
  };
}
function cleanup(c: { journal: WorkflowJournal }) { rmSync((c.journal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("loopUntilDry accumulates + de-dupes until consecutiveEmpty empty rounds", async () => {
  // round 0 → ["a","b"]; round 1 → ["b","c"]; round 2 → [] (1st empty); round 3 → [] (2nd empty → stop)
  const c = ctx(['["a","b"]','["b","c"]',"[]","[]"]);
  try {
    const r = await loopUntilDry({ round: (n) => (n < 4 ? JSON.parse(['["a","b"]','["b","c"]',"[]","[]"][n] ?? "[]") : []) , consecutiveEmpty: 2, maxRounds: 10 }, c);
    assert.deepEqual(r.sort(), ["a","b","c"]);
  } finally { cleanup(c); }
});

test("loopUntilDry stops at maxRounds even if not dry", async () => {
  const c = ctx(Array(20).fill('["x"]'));
  try {
    const r = await loopUntilDry({ round: (n) => n < 5 ? [`item${n}`] : [], consecutiveEmpty: 99, maxRounds: 5 }, c);
    assert.equal(r.length, 5);
  } finally { cleanup(c); }
});

test("loopUntilDry returns [] when first round is empty", async () => {
  const c = ctx(["[]","[]"]);
  try { const r = await loopUntilDry({ round: () => [], consecutiveEmpty: 1 }, c); assert.deepEqual(r, []); } finally { cleanup(c); }
});
