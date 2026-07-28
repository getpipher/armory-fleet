import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetTool, type FleetToolDeps } from "../src/tools/fleet.ts";
import { WorkflowJournal } from "../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(overrides: Partial<FleetToolDeps> = {}): FleetToolDeps {
  return {
    runWorkflow: async (_script, opts, _d) => ({ runId: opts.runId ?? "wf-test", status: "completed", result: "ok", phases: [] }),
    workflowJournal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-tool-"))),
    workflowRegistry: { get: () => undefined, list: () => [] },
    resolveWorkflow: () => undefined,
    notify: () => {},
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    ...overrides,
  } as FleetToolDeps;
}
function cleanup(d: FleetToolDeps) { rmSync((d.workflowJournal as unknown as { dir: string }).dir, { recursive: true, force: true }); }

test("fleet workflow action: runs a script, returns runId + status", async () => {
  const d = deps();
  try {
    const tool = createFleetTool(d);
    const res = await tool.execute("c1", { action: "workflow", script: "module.exports = 1", background: false } as never, new AbortController().signal, null, null);
    assert.equal(res.isError, undefined);
    assert.match((res.details as { runId: string }).runId, /^wf-/);
  } finally { cleanup(d); }
});

test("fleet workflow action: missing script → isError", async () => {
  const d = deps();
  try {
    const tool = createFleetTool(d);
    const res = await tool.execute("c1", { action: "workflow", background: false } as never, new AbortController().signal, null, null);
    assert.equal(res.isError, true);
  } finally { cleanup(d); }
});

test("fleet workflow_control list → returns runIds", async () => {
  const d = deps();
  try {
    const tool = createFleetTool(d);
    const res = await tool.execute("c1", { action: "workflow_control", control: "list" } as never, new AbortController().signal, null, null);
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(typeof text === "string");
  } finally { cleanup(d); }
});

test("fleet workflow_control status: missing runId → isError", async () => {
  const d = deps();
  try {
    const tool = createFleetTool(d);
    const res = await tool.execute("c1", { action: "workflow_control", control: "status", runId: "nope" } as never, new AbortController().signal, null, null);
    assert.equal(res.isError, true);
  } finally { cleanup(d); }
});
