import { test } from "node:test"
import assert from "node:assert/strict"
import type { WorkflowStartInput, WorkflowStartReceipt, WorkflowRunState } from "../src/workflows/runtime/types.ts"
import type { WorkflowRunResult } from "../src/workflows/runner.ts"
import type { WorkflowDef } from "../src/workflows/registry.ts"
import { createFleetTool } from "../src/tools/fleet.ts"
import { workflowKeywordHint } from "../src/workflows/keyword.ts"
import type { WorkflowController } from "../src/workflows/runtime/controller.ts"

// ── Recording fake controller (inline — does NOT touch the shared fixture) ──

interface StartRequest {
  input: WorkflowStartInput
  signal?: AbortSignal
}

function fakeController(opts: {
  start?: (input: WorkflowStartInput, signal?: AbortSignal) => Promise<WorkflowStartReceipt | WorkflowRunResult>
} = {}) {
  const calls: string[] = []
  const startRequests: (StartRequest | undefined)[] = []
  const runs: WorkflowRunState[] = []
  const runMap = new Map<string, WorkflowRunState>([[
    "wf-1",
    { runId: "wf-1", name: "test", script: "", mode: "auto", status: "running", startedAt: 0, currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0 },
  ]])

  const controller = {
    calls,
    startRequests,
    definitions(): WorkflowDef[] { calls.push("definitions"); return [] },
    runs(): WorkflowRunState[] { calls.push("list"); return runs },
    getRun(runId: string): WorkflowRunState | undefined { calls.push("status"); return runMap.get(runId) },
    async start(input: WorkflowStartInput, ctx?: { signal?: AbortSignal }): Promise<WorkflowStartReceipt | WorkflowRunResult> {
      calls.push("start")
      const signal = ctx?.signal
      startRequests.length = 0
      startRequests.push(signal ? { input, signal } : undefined)
      if (opts.start) return opts.start(input, signal)
      return { runId: "wf-1", status: "background" as const }
    },
    pause(runId: string): void { calls.push("pause") },
    async resume(runId: string): Promise<WorkflowStartReceipt | WorkflowRunResult> { calls.push("resume"); return { runId, status: "background" as const } },
    async stop(runId: string): Promise<void> { calls.push("stop") },
    respondToCheckpoint(runId: string, response: unknown): void { calls.push("respondToCheckpoint") },
    async settled(runId: string): Promise<WorkflowRunResult | undefined> { calls.push("settled"); return undefined },
    save(input: { name: string; source: string; overwrite?: boolean }): WorkflowDef { calls.push("save"); return {} as WorkflowDef },
    async editAndResume(runId: string, source: string): Promise<WorkflowStartReceipt | WorkflowRunResult> { calls.push("editAndResume"); return { runId: "wf-2", status: "background" as const } },
    hydrate(): void { calls.push("hydrate") },
  }
  return controller
}

type FakeController = ReturnType<typeof fakeController>

async function execute(tool: ReturnType<typeof createFleetTool>, params: Record<string, unknown>, signal?: AbortSignal) {
  const raw = await tool.execute("c1", params as never, signal ?? null, null, null)
  return raw as { isError?: boolean; content: Array<{ type: string; text: string }>; details?: unknown }
}

// ── Tests ──

test("workflow validates script xor workflowName and delegates all options", async () => {
  const calls: WorkflowStartInput[] = []
  const controller = fakeController({ start: async (input) => { calls.push(input); return { runId: "wf-1", status: "background" } } })
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController })
  const res = await execute(tool, {
    action: "workflow", workflowName: "code-review", background: true,
    concurrency: 4, agentRetries: 2, agentTimeoutMs: 1000, tokenBudget: 4000,
  })
  assert.deepEqual(calls[0], {
    workflowName: "code-review", mode: "auto", background: true, concurrency: 4,
    agentRetries: 2, agentTimeoutMs: 1000, tokenBudget: 4000,
  })
  assert.equal(res.isError, undefined)
  assert.equal((await execute(tool, { action: "workflow", script: "x", workflowName: "y" })).isError, true)
})

test("workflow_control delegates list/status/pause/resume/stop without stub responses", async () => {
  const controller = fakeController()
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController })
  for (const control of ["list", "status", "pause", "resume", "stop"] as const) {
    const res = await execute(tool, { action: "workflow_control", control, ...(control === "list" ? {} : { runId: "wf-1" }) })
    assert.equal(res.isError, undefined)
    assert.equal(controller.calls.at(-1), control)
  }
})

test("foreground forwards the tool signal while background detaches", async () => {
  const controller = fakeController()
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController })
  const signal = new AbortController().signal
  await tool.execute("c1", { action: "workflow", script: "return 1", background: false } as never, signal, null, null)
  assert.equal(controller.startRequests.at(-1)?.signal, signal)
  await tool.execute("c2", { action: "workflow", script: "return 1", background: true } as never, signal, null, null)
  assert.equal(controller.startRequests.at(-1), undefined)
})

test("bounded keyword authorizes workflow but identifiers do not", () => {
  assert.match(workflowKeywordHint("use a workflow for this") ?? "", /authorized/)
  assert.equal(workflowKeywordHint("src/workflow-editor.ts"), undefined)
  assert.equal(workflowKeywordHint("myworkflow_name"), undefined)
})

test("#37 workflow_control status surfaces the abort reason (not just 'aborted')", async () => {
  // Previously: `workflow wf-x: aborted` with no WHY. Now the status text includes the reason so the
  // orchestrator can tell a script error from a budget/timeout/signal abort. Inline controller with
  // an aborted run carrying an error (the runner captures the throw/signal reason into run.error).
  const abortedRun: WorkflowRunState = {
    runId: "wf-abort1", name: "t", script: "", mode: "auto", status: "aborted", startedAt: 0, endedAt: 1,
    currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0,
    error: "token budget exceeded",
  };
  const controller = {
    definitions: () => [], runs: () => [], getRun: () => abortedRun,
    start: async () => ({ runId: "wf-abort1", status: "background" as const }),
    pause: () => {}, resume: async () => ({ runId: "wf-abort1", status: "background" as const }),
    stop: async () => {}, respondToCheckpoint: () => {}, settled: async () => undefined,
    save: () => ({} as WorkflowDef), editAndResume: async () => ({ runId: "wf-2", status: "background" as const }), hydrate: () => {},
  };
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController });
  const res = await execute(tool, { action: "workflow_control", control: "status", runId: "wf-abort1" });
  assert.equal(res.isError, undefined);
  const text = res.content[0]!.text;
  assert.match(text, /workflow wf-abort1: aborted — token budget exceeded/, `status text surfaces the reason: ${text}`);
  // details.run.error still carries the full reason.
  assert.equal((res.details as { run: { error?: string } }).run.error, "token budget exceeded");
});

test("#37 workflow_control status for a completed run stays concise (no reason)", async () => {
  const completedRun: WorkflowRunState = {
    runId: "wf-ok", name: "t", script: "", mode: "auto", status: "completed", startedAt: 0, endedAt: 1,
    currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0,
  };
  const controller = {
    definitions: () => [], runs: () => [], getRun: () => completedRun,
    start: async () => ({ runId: "wf-ok", status: "background" as const }),
    pause: () => {}, resume: async () => ({ runId: "wf-ok", status: "background" as const }),
    stop: async () => {}, respondToCheckpoint: () => {}, settled: async () => undefined,
    save: () => ({} as WorkflowDef), editAndResume: async () => ({ runId: "wf-2", status: "background" as const }), hydrate: () => {},
  };
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController });
  const res = await execute(tool, { action: "workflow_control", control: "status", runId: "wf-ok" });
  const text = res.content[0]!.text;
  assert.equal(text, "workflow wf-ok: completed", `completed run stays concise (no reason appended): ${text}`);
});

test("#37 workflow_control status truncates a very long abort reason", async () => {
  const longReason = "x".repeat(500);
  const abortedRun: WorkflowRunState = {
    runId: "wf-long", name: "t", script: "", mode: "auto", status: "aborted", startedAt: 0, endedAt: 1,
    currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0,
    error: longReason,
  };
  const controller = {
    definitions: () => [], runs: () => [], getRun: () => abortedRun,
    start: async () => ({ runId: "wf-long", status: "background" as const }),
    pause: () => {}, resume: async () => ({ runId: "wf-long", status: "background" as const }),
    stop: async () => {}, respondToCheckpoint: () => {}, settled: async () => undefined,
    save: () => ({} as WorkflowDef), editAndResume: async () => ({ runId: "wf-2", status: "background" as const }), hydrate: () => {},
  };
  const tool = createFleetTool({ getController: () => controller as unknown as WorkflowController });
  const res = await execute(tool, { action: "workflow_control", control: "status", runId: "wf-long" });
  const text = res.content[0]!.text;
  assert.ok(text.includes("…(truncated"), `long reason truncated in text: ${text.slice(-60)}`);
  assert.equal((res.details as { run: { error?: string } }).run.error, longReason, "details keeps the full reason");
});

