// SPEC-6-3 §6/§7 — session-scoped workflow controller. Owns starts, background completion,
// ResultsInbox delivery, atomic Save-as, and the control state machine (pause/resume/stop/
// respondToCheckpoint). index.ts (Task 13) just constructs this.
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
  WorkflowProgressEvent,
} from "./types.ts"
import type { WorkflowDef, WorkflowRegistry } from "../registry.ts"
import { parseWorkflowSource } from "../source.ts"
import { saveWorkflowAtomic } from "./save.ts"
import { discoverWorkflows } from "../registry.ts"
import { PauseGate } from "./pause-gate.ts"

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

interface RunControls {
  abort: AbortController
  gate: PauseGate
  checkpointResolver: ((response: unknown) => void) | undefined
  sourceText: string | undefined
  executable: string
  input: WorkflowStartInput
}

export class WorkflowController {
  private readonly active = new Map<string, Promise<WorkflowRunResult>>()
  private readonly controls = new Map<string, RunControls>()

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

    if (hasScript && hasName) {
      throw new Error("provide exactly one of script or workflowName")
    }
    if (!hasScript && !hasName) {
      throw new Error("exactly one of script or workflowName is required")
    }

    const runId = this.deps.genRunId()
    const background = input.background !== false

    let executable: string
    let sourceText: string | undefined
    let displayName: string

    if (input.script !== undefined) {
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

    // Per-run controls: AbortController + PauseGate + optional checkpoint resolver.
    const abort = new AbortController()
    const gate = new PauseGate()

    const onProgress = (event: WorkflowProgressEvent): void => {
      this.onProgress(runId, event)
    }

    // The controls object is stored in the map and mutated by onCheckpoint/respondToCheckpoint.
    const controls: RunControls = {
      abort,
      gate,
      checkpointResolver: undefined,
      sourceText,
      executable,
      input,
    }
    this.controls.set(runId, controls)

    // Build runDeps: base from factory + runtime hooks merged on top.
    const baseRunDeps = this.deps.runDepsFactory(runId)
    const runDeps: WorkflowRunDeps = {
      ...baseRunDeps,
      runtime: {
        signal: abort.signal,
        waitIfPaused: () => gate.wait(abort.signal),
        onProgress,
      },
      ...(input.mode === "checkpointed"
        ? {
            onCheckpoint: (prompt: string, opts: Record<string, unknown>) => {
              return new Promise<unknown>((resolve) => {
                controls.checkpointResolver = resolve
                const existing = this.deps.store.get(runId)
                if (existing) {
                  this.deps.store.set(runId, {
                    ...existing,
                    status: "checkpoint",
                    checkpoint: { prompt, opts },
                  })
                }
              })
            },
          }
        : {}),
    }

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

    if (background) {
      const promise = this.execute(state, runOpts, runDeps)
      this.active.set(runId, promise)
      void promise.finally(() => {
        this.active.delete(runId)
        // Keep controls until after terminal so stop() can reach them;
        // but if the run settled naturally, clean up.
        const ctrl = this.controls.get(runId)
        if (ctrl && !ctrl.abort.signal.aborted) {
          this.controls.delete(runId)
        }
      })
      return { runId, status: "background" }
    }

    return this.execute(state, runOpts, runDeps)
  }

  private async execute(
    state: WorkflowRunState,
    runOpts: WorkflowRunOpts,
    runDeps: WorkflowRunDeps,
  ): Promise<WorkflowRunResult> {
    try {
      const result = await this.deps.runWorkflow(runOpts.script, runOpts, runDeps)
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

  private onProgress(runId: string, event: WorkflowProgressEvent): void {
    const existing = this.deps.store.get(runId)
    if (!existing) return

    // Don't overwrite terminal statuses set by onTerminal or stop().
    if (
      existing.status === "completed" ||
      existing.status === "aborted" ||
      existing.status === "failed"
    ) {
      return
    }

    // Don't overwrite control-set statuses (paused, checkpoint) with runner progress.
    // Patch non-status fields from the snapshot but preserve the control status.
    if (existing.status === "paused" || existing.status === "checkpoint") {
      this.deps.store.set(runId, {
        ...existing,
        ...event.snapshot,
        status: existing.status,
        ...(existing.checkpoint ? { checkpoint: existing.checkpoint } : {}),
      })
      return
    }

    // For "running" status, patch with the runner's snapshot.
    this.deps.store.set(runId, {
      ...existing,
      ...event.snapshot,
      status: event.snapshot.status,
    })
  }

  private onTerminal(result: WorkflowRunResult, state: WorkflowRunState): void {
    const existing = this.deps.store.get(result.runId)
    if (!existing) return

    // Don't overwrite an aborted status set by stop() with a late completion.
    if (existing.status === "aborted" && result.status === "completed") {
      this.controls.delete(result.runId)
      return
    }

    // Don't overwrite a checkpoint status — the run is awaiting a human response.
    // The runner shouldn't reach terminal while blocked on a checkpoint, but defend anyway.
    if (existing.status === "checkpoint") {
      return
    }

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

    const inboxResult: RunResult = {
      runId: result.runId,
      task: state.name,
      status: result.status === "completed" ? "completed" : "failed",
      summary: safeSummary(result.result ?? result.error ?? result.status),
      paths: [],
      completedAt: Date.now(),
    }
    this.deps.inbox.push(inboxResult)
    this.controls.delete(result.runId)
  }

  // ── Control state machine ──

  pause(runId: string): void {
    const run = this.deps.store.get(runId)
    if (!run) throw new Error(`cannot pause: run '${runId}' not found`)
    const status = run.status
    if (status === "paused") return // idempotent
    if (status !== "running" && status !== "queued") {
      throw new Error(`cannot pause run '${runId}' in status '${status}'`)
    }
    const ctrl = this.controls.get(runId)
    if (ctrl) ctrl.gate.pause()
    this.deps.store.set(runId, { ...run, status: "paused" })
  }

  resume(runId: string): Promise<WorkflowStartReceipt | WorkflowRunResult> {
    const run = this.deps.store.get(runId)
    if (!run) throw new Error(`cannot resume: run '${runId}' not found`)
    const status = run.status

    if (status === "running") return Promise.resolve({ runId, status: "background" as const })
    if (status === "interrupted") {
      // Start a NEW background run with original source + resumeFromRunId.
      const ctrl = this.controls.get(runId)
      const source = ctrl?.sourceText ?? run.script
      return this.startInternal({
        script: source,
        mode: run.mode,
        resumeFromRunId: runId,
      })
    }
    if (status !== "paused") {
      throw new Error(`cannot resume run '${runId}' in status '${status}'`)
    }
    const ctrl = this.controls.get(runId)
    if (ctrl) ctrl.gate.resume()
    this.deps.store.set(runId, { ...run, status: "running" })
    return Promise.resolve({ runId, status: "background" as const })
  }

  async stop(runId: string): Promise<void> {
    const run = this.deps.store.get(runId)
    if (!run) throw new Error(`cannot stop: run '${runId}' not found`)
    const status = run.status

    if (status === "aborted") return // idempotent

    if (
      status !== "running" &&
      status !== "queued" &&
      status !== "paused" &&
      status !== "checkpoint" &&
      status !== "interrupted"
    ) {
      throw new Error(`cannot stop run '${runId}' in status '${status}'`)
    }

    const ctrl = this.controls.get(runId)

    // Reject checkpoint waiters.
    if (ctrl?.checkpointResolver) {
      ctrl.checkpointResolver(undefined)
      ctrl.checkpointResolver = undefined
    }

    // Abort the run signal (fires for live children).
    if (ctrl) ctrl.abort.abort()

    // Resume paused waiters so they observe the abort.
    if (ctrl) ctrl.gate.resume()

    // Set store status to aborted immediately (stop is synchronous from the caller's view).
    this.deps.store.set(runId, { ...run, status: "aborted", endedAt: Date.now() })

    // Await settlement if there's an active promise.
    await this.settled(runId)

    // Clean up controls.
    this.controls.delete(runId)
  }

  respondToCheckpoint(runId: string, response: unknown): void {
    const run = this.deps.store.get(runId)
    if (!run) throw new Error(`cannot respond to checkpoint: run '${runId}' not found`)
    if (run.status !== "checkpoint") {
      throw new Error(
        `cannot respond to checkpoint for run '${runId}' in status '${run.status}'`,
      )
    }

    const ctrl = this.controls.get(runId)
    if (!ctrl || !ctrl.checkpointResolver) {
      throw new Error(`no pending checkpoint for run '${runId}'`)
    }

    // Resolve the pending checkpoint Promise + clear pending state.
    ctrl.checkpointResolver(response)
    ctrl.checkpointResolver = undefined

    // Restore running status.
    this.deps.store.set(runId, { ...run, status: "running", checkpoint: undefined })
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
