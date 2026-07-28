import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/workflows/helpers/retry.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowJournal } from "../src/workflows/journal.ts";

function ctx() {
  let i = 0;
  return {
    spawn: async () => ({ finalText: "", runId: "fl-x", status: "completed" as const }),
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-h-"))),
    runId: "wf-retry",
    nextCallIndex: () => i++,
  };
}

test("retry returns the first result when until is omitted", async () => {
  let calls = 0;
  const r = await retry((n) => { calls++; return `r${n}`; }, {}, ctx());
  assert.equal(r, "r0");
  assert.equal(calls, 1);
});

test("retry re-runs on until=false up to attempts", async () => {
  let calls = 0;
  const r = await retry((n) => { calls++; return n; }, { attempts: 3, until: (v) => (v as number) >= 2 }, ctx());
  assert.equal(r, 2);
  assert.equal(calls, 3);
});

test("retry exhausts attempts and returns the last result", async () => {
  let calls = 0;
  const r = await retry((n) => { calls++; return n; }, { attempts: 2, until: () => false }, ctx());
  assert.equal(r, 1);
  assert.equal(calls, 2);
});

test("retry propagates a throwing thunk as a failed result (returns last attempt)", async () => {
  let calls = 0;
  const r = await retry((n) => { calls++; if (n < 1) throw new Error("boom"); return "ok"; }, { attempts: 3 }, ctx());
  assert.equal(r, "ok");
  assert.equal(calls, 2);
});
