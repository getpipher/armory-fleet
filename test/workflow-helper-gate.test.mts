import { test } from "node:test";
import assert from "node:assert/strict";
import { gate } from "../src/workflows/helpers/gate.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx() { let i = 0; return { spawn: async () => null, journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-g-"))), runId: "wf-gate", nextCallIndex: () => i++ }; }

test("gate passes first try when validator says ok", async () => {
  const r = await gate(async () => "v1", () => ({ ok: true }), {}, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.value, "v1");
  assert.equal(r.attempts, 1);
});

test("gate re-runs with feedback until validator ok or attempts exhausted", async () => {
  let attempt = 0;
  const r = await gate(
    async (fb, n) => { attempt = n; return fb ? `${fb}-${n}` : `v${n}`; },
    (v) => (v as string).startsWith("fix") ? { ok: true } : { ok: false, feedback: "fix it" },
    { attempts: 3 },
    ctx(),
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, "fix it-1");
  assert.equal(r.attempts, 2);
});

test("gate exhausts attempts returning ok=false + last value", async () => {
  const r = await gate(async (_fb, n) => `v${n}`, () => ({ ok: false, feedback: "no" }), { attempts: 2 }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.equal(r.value, "v1");
});
