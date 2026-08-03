// SPEC-6-3 §6 — session-scoped workflow controller. Owns starts, background completion,
// ResultsInbox delivery, and atomic Save-as. index.ts (Task 13) just constructs this.
import type { WorkflowRunStore } from "./run-store.ts"
import type { WorkflowJournal } from "../journal.ts"
import type { ResultsInbox, RunResult } from "../../runtime/results-inbox.ts"
import type {
  WorkflowRunDeps,
  WorkflowRunOpts,
  WorkflowRunResult,
} from "../runner.ts"
import type {
  WorkflowStartInput,
  WorkflowStartReceipt,
  WorkflowRunState,
  WorkflowSaveInput,
} from "./types.ts"
import type { WorkflowDef, WorkflowRegistry } from "../registry.ts"
import { parseWorkflowSource } from "../source.ts"
import { saveWorkflowAtomic, type SaveInput } from "./save.ts"
import { discoverWorkflows } from "../registry.ts"

export interface WorkflowControllerDeps {
  registry: WorkflowRegistry
  projectDir: string
  store: WorkflowRunStore
  journal: WorkflowJournal
  runWorkflow: (
    script: string,
    opts: WorkflowRunOpts,
    deps: WorkflowRunDeps,
  ) => Promise<WorkflowRunResult>
  runDepsFactory: (runId: string) => WorkflowRunDeps
  inbox: ResultsInbox
  genRunId: () => string
  notify: (msg: string, level?: "info" | "warning" | "error") => void
}

const SUMMARY_BOUND = 500

function safeSummary(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.slice(0, SUMMARY_BOUND)
}

export class WorkflowController {
  private readonly active = new Map<string, Promise<WorkflowRunResult>>()

  constructor(private readonly deps: WorkflowControllerDeps) {}

  definitions(): WorkflowDef[] {
    return this.deps.registry.list()
  }

  runs(): WorkflowRunState[] {
    return this.deps.store.values()
  }

  getRun(runId: string): WorkflowRunState | undefined {
    return this.deps.store.get(runId)
  }

  start(
    input: WorkflowStartInput,
    _ctx?: { signal?: AbortSignal },
  ): Promise<WorkflowStartReceipt | WorkflowRunResult> {
    return this.startInternal(input)
  }

  private async startInternal(
    input: WorkflowStartInput,
  ): Promise<WorkflowStartReceipt | WorkflowRunResult> {
    const hasScript = input.script !== undefined
    const hasName = input.workflowName !== undefined

    // Exactly one of script or workflowName is required.
    // If both are given, throw /exactly one/.
    if (hasScript && hasName) {
      throw new Error("provide exactly one of script or workflowName")
    }
    if (!hasScript && !hasName) {
      throw new Error("exactly one of script or workflowName is required")
    }

    const runId = this.deps.genRunId()
    const background = input.background !== false

    // Resolve input → executable
    let executable: string
    let sourceText: string | undefined
    let displayName: string

    if (input.script !== undefined) {
      // script + name → save first (before creating a run row)
      if (input.name) {
        this.save({ name: input.name, source: input.script })
      }
      const parsed = parseWorkflowSource(input.script, {
        filePath: `${input.name ?? runId}.js`,
        requireMeta: false,
      })
      executable = parsed.executable
      sourceText = parsed.source
      displayName = input.name ?? runId
    } else if (input.workflowName !== undefined) {
      const def = this.deps.registry.get(input.workflowName)
      if (!def) {
        const available = this.deps.registry.list().map((w) => w.name).join(", ")
        throw new Error(
          `workflow '${input.workflowName}' not found; available: ${available}`,
        )
      }
      executable = def.executable
      sourceText = def.sourceText
      displayName = input.workflowName
    } else {
      throw new Error("exactly one of script or workflowName is required")
    }

    // Create the run row BEFORE execution
    const now = Date.now()
    const state: WorkflowRunState = {
      runId,
      name: displayName,
      script: sourceText ?? executable,
      ...(input.args !== undefined ? { args: input.args } : {}),
      mode: input.mode,
      status: "running",
      startedAt: now,
      currentPhase: "default",
      phases: [],
      childRunIds: [],
      logs: [],
      tokenTotal: 0,
      costTotal: 0,
      ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
    }
    this.deps.store.set(runId, state)
    // Note: the runner appends `wf:started` (canonical — it owns sourceText/mode/phases).
    // The controller owns only the store row + ResultsInbox delivery; it does NOT journal wf:started
    // (avoids a double-append that would corrupt hydration/replay).

    const runOpts: WorkflowRunOpts = {
      script: executable,
      ...(sourceText ? { sourceText } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      runId,
      ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
      mode: input.mode,
      ...(input.tokenBudget !== undefined ? { budget: { total: input.tokenBudget } } : {}),
      ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.agentRetries !== undefined ? { agentRetries: input.agentRetries } : {}),
      ...(input.agentTimeoutMs !== undefined ? { agentTimeoutMs: input.agentTimeoutMs } : {}),
    }

    const runDeps = this.deps.runDepsFactory(runId)

    if (background) {
      const promise = this.execute(state, executable, input, runOpts, runDeps)
      this.active.set(runId, promise)
      void promise.finally(() => this.active.delete(runId))
      return { runId, status: "background" }
    }

    return this.execute(state, executable, input, runOpts, runDeps)
  }

  private async execute(
    state: WorkflowRunState,
    executable: string,
    input: WorkflowStartInput,
    runOpts: WorkflowRunOpts,
    runDeps: WorkflowRunDeps,
  ): Promise<WorkflowRunResult> {
    try {
      const result = await this.deps.runWorkflow(executable, runOpts, runDeps)
      this.onTerminal(result, state)
      return result
    } catch (e) {
      const result: WorkflowRunResult = {
        runId: state.runId,
        status: "aborted",
        error: (e as Error).message,
        phases: [],
        childRunIds: [],
        logs: [],
      }
      this.onTerminal(result, state)
      return result
    }
  }

  private onTerminal(result: WorkflowRunResult, state: WorkflowRunState): void {
    const existing = this.deps.store.get(result.runId)
    if (!existing) return

    const status: WorkflowRunState["status"] =
      result.status === "completed"
        ? "completed"
        : result.status === "aborted"
          ? "aborted"
          : "failed"

    this.deps.store.set(result.runId, {
      ...existing,
      status,
      endedAt: Date.now(),
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.costTotal !== undefined ? { costTotal: result.costTotal } : {}),
      ...(result.tokenTotal !== undefined ? { tokenTotal: result.tokenTotal } : {}),
      phases: result.phases,
      childRunIds: result.childRunIds,
      logs: result.logs,
    })

    // Push to ResultsInbox
    const inboxResult: RunResult = {
      runId: result.runId,
      task: state.name,
      status: result.status === "completed" ? "completed" : "failed",
      summary: safeSummary(result.result ?? result.error ?? result.status),
      paths: [],
      completedAt: Date.now(),
    }
    this.deps.inbox.push(inboxResult)
  }

  async settled(runId: string): Promise<WorkflowRunResult | undefined> {
    const promise = this.active.get(runId)
    if (promise) return promise
    return undefined
  }

  save(input: WorkflowSaveInput): WorkflowDef {
    const saved = saveWorkflowAtomic({ ...input, dir: this.deps.projectDir })
    this.refreshRegistry()
    return saved
  }

  editAndResume(
    runId: string,
    source: string,
  ): Promise<WorkflowStartReceipt | WorkflowRunResult> {
    const existing = this.deps.store.get(runId)
    if (!existing) throw new Error(`run '${runId}' not found`)
    return this.startInternal({
      script: source,
      name: existing.name !== existing.runId ? existing.name : undefined,
      mode: existing.mode,
      resumeFromRunId: runId,
    })
  }

  private refreshRegistry(): void {
    const result = discoverWorkflows({
      projectDir: this.deps.projectDir,
      globalDir: "",
      builtinDir: "",
    })
    const existing = this.deps.registry.list()
    const merged = new Map<string, WorkflowDef>()
    for (const w of existing) merged.set(w.name, w)
    for (const w of result.workflows.values()) merged.set(w.name, w)
    this.deps.registry.replace([...merged.values()])
  }
}
