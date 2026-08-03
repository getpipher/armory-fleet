import { test } from "node:test"
import assert from "node:assert/strict"
import { workflowKeywordHint } from "../src/workflows/keyword.ts"

test("bounded keyword authorizes workflow but identifiers do not", () => {
  assert.match(workflowKeywordHint("use a workflow for this") ?? "", /authorized/)
  assert.equal(workflowKeywordHint("src/workflow-editor.ts"), undefined)
  assert.equal(workflowKeywordHint("myworkflow_name"), undefined)
})
