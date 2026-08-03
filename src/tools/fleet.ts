// SPEC-6-3 §3.6 — the model-callable fleet tool surface for workflows. Folded into the fleet
// tool family (alongside subagent + fleet_results), not a brand-new unrelated tool.
import { Type, type Static } from "typebox";
import type { WorkflowRunResult } from "../workflows/runner.ts";

export interface FleetToolDeps {
  runWorkflow: (script: string, opts: { script: string; args?: unknown; runId?: string; resumeFromRunId?: string; mode: "auto" | "checkpointed"; background?: boolean; maxAgents?: number; concurrency?: number; agentRetries?: number; agentTimeoutMs?: number; budget?: { total: number } }, deps: unknown) => Promise<WorkflowRunResult>;
  workflowJournal: { scanNonTerminal: () => string[]; replay: (runId: string) => unknown[] };
  workflowRegistry: { get: (name: string) => { executable: string } | undefined; list: () => { name: string; description: string }[] };
  resolveWorkflow: (name: string) => { sourceText: string; executable: string } | undefined;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
  genRunId: () => string;
  /** The full WorkflowRunDeps wired by index.ts (passed through to runWorkflow). */
  runnerDeps: unknown;
}

export const fleetParams = Type.Object({
  action: Type.Union([Type.Literal("workflow"), Type.Literal("workflow_control")], { description: "The fleet workflow action." }),
  // workflow action
  script: Type.Optional(Type.String({ description: "The JS workflow script (for action: 'workflow')." })),
  name: Type.Optional(Type.String({ description: "Save-as name (for action: 'workflow')." })),
  args: Type.Optional(Type.Unknown({ description: "Args passed to the script as `args`." })),
  background: Type.Optional(Type.Boolean({ description: "Non-blocking (default true). Ignored when background dispatch isn't configured." })),
  resumeFromRunId: Type.Optional(Type.String({ description: "Edit-and-resume: replay the unchanged prefix, re-run the edited suffix." })),
  maxAgents: Type.Optional(Type.Number({ description: "Hard cap on total agent() calls (default 1000)." })),
  concurrency: Type.Optional(Type.Number({ description: "Parallel agent() concurrency (default 3, clamped 16)." })),
  agentRetries: Type.Optional(Type.Number({ description: "Default per-agent retries." })),
  agentTimeoutMs: Type.Optional(Type.Number({ description: "Default per-agent timeoutMs." })),
  tokenBudget: Type.Optional(Type.Number({ description: "Run-level token budget (budget.total)." })),
  // workflow_control action
  control: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")], { description: "The control operation (for action: 'workflow_control')." })),
  runId: Type.Optional(Type.String({ description: "The workflow runId (for status/pause/resume/stop)." })),
});

export type FleetInput = Static<typeof fleetParams>;

export function createFleetTool(deps: FleetToolDeps) {
  return {
    name: "fleet",
    label: "Fleet",
    description: "Run + control armory-fleet workflows (JS orchestration with agent/parallel/pipeline/phase + journaled resume). Action 'workflow' runs a script; 'workflow_control' list/status/pause/resume/stop a run.",
    promptSnippet: "Run or control a fleet workflow",
    promptGuidelines: [
      "Use action 'workflow' to run a JS workflow script that fans out across agents via agent()/parallel()/pipeline().",
      "Use action 'workflow_control' with control 'list'/'status'/'pause'/'resume'/'stop' to manage a running workflow by runId.",
      "Pass resumeFromRunId to edit-and-resume: the unchanged agent() prefix replays from cache; edited + new calls re-run.",
    ],
    parameters: fleetParams,
    async execute(_id: string, params: FleetInput, _signal: AbortSignal, _onUpdate: unknown, _ctx: unknown) {
      if (params.action === "workflow") {
        if (!params.script) return { isError: true, content: [{ type: "text" as const, text: "action 'workflow' requires `script`" }] };
        const runId = deps.genRunId();
        const budget = params.tokenBudget != null ? { total: params.tokenBudget } : undefined;
        const res = await deps.runWorkflow(params.script, { script: params.script, args: params.args, runId, ...(params.resumeFromRunId ? { resumeFromRunId: params.resumeFromRunId } : {}), mode: "auto", ...(params.maxAgents ? { maxAgents: params.maxAgents } : {}), ...(params.concurrency ? { concurrency: params.concurrency } : {}), ...(params.agentRetries ? { agentRetries: params.agentRetries } : {}), ...(params.agentTimeoutMs ? { agentTimeoutMs: params.agentTimeoutMs } : {}), ...(budget ? { budget } : {}) }, deps.runnerDeps);
        const isError = res.status === "aborted" || res.status === "failed";
        return { content: [{ type: "text" as const, text: isError ? (res.error ?? res.status) : `workflow ${res.runId}: ${res.status}` }], details: { runId: res.runId, status: res.status }, isError: isError || undefined };
      }
      // action === "workflow_control"
      const ctrl = params.control ?? "list";
      if (ctrl === "list") {
        const ids = deps.workflowJournal.scanNonTerminal();
        return { content: [{ type: "text" as const, text: `workflows: ${ids.length ? ids.join(", ") : "(none running)"}` }], details: { runIds: ids } };
      }
      if (!params.runId) return { isError: true, content: [{ type: "text" as const, text: `control '${ctrl}' requires \`runId\`` }] };
      // status: replay the journal for a summary (pause/resume/stop stub for the runtime — the panel drives live control).
      const events = deps.workflowJournal.replay(params.runId) as Array<{ type: string }>;
      if (events.length === 0) return { isError: true, content: [{ type: "text" as const, text: `workflow '${params.runId}' not found` }] };
      return { content: [{ type: "text" as const, text: `workflow ${params.runId}: ${ctrl} (events: ${events.length})` }], details: { runId: params.runId, control: ctrl } };
    },
  };
}
