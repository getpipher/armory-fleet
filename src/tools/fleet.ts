// SPEC-6-3 §9 — the model-callable fleet tool surface for workflows.
// Thin delegation to WorkflowController via a getter (prevents duplicate registration).
import { Type, type Static } from "typebox"

import type { WorkflowController } from "../workflows/runtime/controller.ts"
import type { WorkflowStartInput, WorkflowRunState, WorkflowStartReceipt } from "../workflows/runtime/types.ts"
import type { WorkflowRunResult } from "../workflows/runner.ts"

export interface FleetToolDeps {
  getController: () => WorkflowController
}

export const fleetParams = Type.Object({
  action: Type.Union([Type.Literal("workflow"), Type.Literal("workflow_control")], { description: "The fleet workflow action." }),
  // workflow action
  script: Type.Optional(Type.String({ description: "The JS workflow script (for action: 'workflow')." })),
  name: Type.Optional(Type.String({ description: "Save-as name (for action: 'workflow')." })),
  workflowName: Type.Optional(Type.String({ description: "Run a saved workflow by name." })),
  overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing saved workflow." })),
  args: Type.Optional(Type.Unknown({ description: "Args passed to the script as `args`." })),
  background: Type.Optional(Type.Boolean({ description: "Non-blocking (default true)." })),
  resumeFromRunId: Type.Optional(Type.String({ description: "Edit-and-resume: replay the unchanged prefix, re-run the edited suffix." })),
  maxAgents: Type.Optional(Type.Number({ description: "Hard cap on total agent() calls." })),
  concurrency: Type.Optional(Type.Number({ description: "Parallel agent() concurrency." })),
  agentRetries: Type.Optional(Type.Number({ description: "Default per-agent retries." })),
  agentTimeoutMs: Type.Optional(Type.Number({ description: "Default per-agent timeoutMs." })),
  tokenBudget: Type.Optional(Type.Number({ description: "Run-level token budget." })),
  // workflow_control action
  control: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")], { description: "The control operation." })),
  runId: Type.Optional(Type.String({ description: "The workflow runId (for status/pause/resume/stop)." })),
})

export type FleetInput = Static<typeof fleetParams>

export function createFleetTool(deps: FleetToolDeps) {
  return {
    name: "fleet",
    label: "Fleet",
    description: "Run + control armory-fleet workflows (JS orchestration with agent/parallel/pipeline/phase + journaled resume).",
    promptSnippet: "Run or control a fleet workflow",
    promptGuidelines: [
      "Use action 'workflow' to run a JS workflow script or a saved workflow by name.",
      "Use action 'workflow_control' with control 'list'/'status'/'pause'/'resume'/'stop' to manage a running workflow by runId.",
      "Pass resumeFromRunId to edit-and-resume: the unchanged agent() prefix replays from cache; edited + new calls re-run.",
    ],
    parameters: fleetParams,
    async execute(_id: string, params: FleetInput, signal: AbortSignal | null, _onUpdate: unknown, _ctx: unknown) {
      let controller: WorkflowController
      try {
        controller = deps.getController()
      } catch {
        return { isError: true, content: [{ type: "text" as const, text: "workflow runtime not initialized for this session" }] }
      }

      try {
        if (params.action === "workflow") {
          return await handleWorkflowAction(controller, params, signal)
        }
        return await handleControlAction(controller, params)
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }
      }
    },
  }
}

async function handleWorkflowAction(controller: WorkflowController, params: FleetInput, signal: AbortSignal | null) {
  const hasScript = params.script !== undefined
  const hasName = params.workflowName !== undefined

  if (hasScript && hasName) {
    return { isError: true, content: [{ type: "text" as const, text: "provide exactly one of script or workflowName" }] }
  }
  if (!hasScript && !hasName) {
    return { isError: true, content: [{ type: "text" as const, text: "action 'workflow' requires `script` or `workflowName`" }] }
  }

  // resumeFromRunId → editAndResume
  if (params.resumeFromRunId) {
    const result = await controller.editAndResume(params.resumeFromRunId, params.script ?? "")
    return serializeRunResult(result)
  }

  // Build the delegated WorkflowStartInput with conditional spreads (exact deepEqual match).
  const input: WorkflowStartInput = {
    mode: "auto",
    ...(params.script !== undefined ? { script: params.script } : {}),
    ...(params.workflowName !== undefined ? { workflowName: params.workflowName } : {}),
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.overwrite !== undefined ? { overwrite: params.overwrite } : {}),
    ...(params.args !== undefined ? { args: params.args } : {}),
    ...(params.background !== undefined ? { background: params.background } : {}),
    ...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
    ...(params.agentRetries !== undefined ? { agentRetries: params.agentRetries } : {}),
    ...(params.agentTimeoutMs !== undefined ? { agentTimeoutMs: params.agentTimeoutMs } : {}),
    ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
    ...(params.maxAgents !== undefined ? { maxAgents: params.maxAgents } : {}),
  }

  // Foreground: forward the tool signal. Background: detach (no signal).
  const isForeground = params.background === false
  const ctx = isForeground && signal ? { signal } : undefined

  const result = await controller.start(input, ctx)
  return serializeRunResult(result)
}

async function handleControlAction(controller: WorkflowController, params: FleetInput) {
  const control = params.control ?? "list"

  if (control === "list") {
    const runs = controller.runs()
    return {
      content: [{ type: "text" as const, text: `workflows: ${runs.length ? runs.map((r) => r.runId).join(", ") : "(none running)"}` }],
      details: { runs: runs.map(summarizeRun) },
    }
  }

  if (!params.runId) {
    return { isError: true, content: [{ type: "text" as const, text: `control '${control}' requires \`runId\`` }] }
  }

  if (control === "status") {
    const run = controller.getRun(params.runId)
    if (!run) {
      return { isError: true, content: [{ type: "text" as const, text: `workflow '${params.runId}' not found` }] }
    }
    // #37: surface the abort/failure reason in the status text (previously only `status` was shown —
    // `workflow wf-x: aborted` with no WHY, leaving the orchestrator unable to tell a script error from
    // a budget/timeout/signal abort). The `details.run.error` already carried it; this surfaces it in the
    // headline text the model + user see first. Cap very long reasons to keep the status line concise.
    const reason = (run.status === "aborted" || run.status === "failed") && run.error
      ? ` — ${run.error.length > 300 ? run.error.slice(0, 300) + `…(truncated from ${run.error.length} chars, see details.run.error)` : run.error}`
      : "";
    return { content: [{ type: "text" as const, text: `workflow ${run.runId}: ${run.status}${reason}` }], details: { run: summarizeRun(run) } }
  }

  if (control === "pause") {
    controller.pause(params.runId)
    return { content: [{ type: "text" as const, text: `workflow ${params.runId}: paused` }], details: { runId: params.runId, status: "paused" } }
  }

  if (control === "resume") {
    const receipt = await controller.resume(params.runId)
    return { content: [{ type: "text" as const, text: `workflow ${params.runId}: resumed` }], details: { receipt } }
  }

  if (control === "stop") {
    await controller.stop(params.runId)
    return { content: [{ type: "text" as const, text: `workflow ${params.runId}: stopped` }], details: { runId: params.runId, status: "aborted" } }
  }

  return { isError: true, content: [{ type: "text" as const, text: `unknown control '${control}'` }] }
}

function summarizeRun(run: WorkflowRunState): Record<string, unknown> {
  return {
    runId: run.runId,
    name: run.name,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    currentPhase: run.currentPhase,
    phases: run.phases,
    childRunIds: run.childRunIds,
    tokenTotal: run.tokenTotal,
    costTotal: run.costTotal,
    ...(run.error ? { error: run.error } : {}),
  }
}

function serializeRunResult(result: WorkflowStartReceipt | WorkflowRunResult) {
  if ("status" in result && result.status === "background") {
    return {
      content: [{ type: "text" as const, text: `workflow ${result.runId}: background` }],
      details: { runId: result.runId, status: "background" },
    }
  }
  const r = result as WorkflowRunResult
  const isError = r.status === "aborted" || r.status === "failed"
  return {
    content: [{ type: "text" as const, text: isError ? (r.error ?? r.status) : `workflow ${r.runId}: ${r.status}` }],
    details: { runId: r.runId, status: r.status },
    isError: isError || undefined,
  }
}
