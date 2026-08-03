import { test } from "node:test"
import assert from "node:assert/strict"
import type { WorkflowDef } from "../src/workflows/registry.ts"
import type { WorkflowRunState } from "../src/workflows/runtime/types.ts"
import {
  buildWorkflowPanelItems,
  actionsForWorkflowItem,
  parseWorkflowPanelKey,
} from "../src/workflows/panel/workflows-items.ts"

// ── Test factories ──

function definition(source: "builtin" | "global" | "project", name: string): WorkflowDef {
  return {
    name,
    description: "d",
    phases: [{ title: "p" }],
    sourceText: `export const meta = { name: "${name}", description: "d" }\nagent("x")`,
    body: 'agent("x")',
    executable: `module.exports = (async () => {\nagent("x")\n})()`,
    source,
    filePath: `/x/${name}.js`,
  }
}

function run(runId: string, status: WorkflowRunState["status"], startedAt: number): WorkflowRunState {
  return {
    runId,
    name: runId,
    script: "",
    mode: "auto",
    status,
    startedAt,
    currentPhase: "default",
    phases: [],
    childRunIds: [],
    logs: [],
    tokenTotal: 0,
    costTotal: 0,
  }
}

// ── Tests ──

test("combined items show definitions before newest-first runs", () => {
  const items = buildWorkflowPanelItems({
    definitions: [definition("builtin", "code-review"), definition("project", "auth-audit")],
    runs: [run("wf-old", "completed", 1), run("wf-new", "running", 2)],
  })
  assert.deepEqual(items.map((i) => i.value), [
    "definition:auth-audit", "definition:code-review", "run:wf-new", "run:wf-old",
  ])
  assert.match(items[0]!.label, /◇ auth-audit.*\[project\]/)
  assert.match(items[2]!.label, /▶ wf-new.*\[running\]/)
})

test("actions are context-sensitive", () => {
  assert.deepEqual(actionsForWorkflowItem({ kind: "definition", definition: definition("builtin", "x") }), ["run", "open"])
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "paused", 1) }), ["open", "resume", "stop", "save"])
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "checkpoint", 1) }), ["respond", "stop", "open"])
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "completed", 1) }), ["open", "edit-resume", "save", "view-result"])
})
