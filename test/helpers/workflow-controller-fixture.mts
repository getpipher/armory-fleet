import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkflowRunResult } from "../../src/workflows/runner.ts"
import type { WorkflowRunState } from "../../src/workflows/runtime/types.ts"
import { WorkflowJournal } from "../../src/workflows/journal.ts"
import { WorkflowRunStore } from "../../src/workflows/runtime/run-store.ts"
import { ResultsInbox } from "../../src/runtime/results-inbox.ts"
import { WorkflowRegistry } from "../../src/workflows/registry.ts"
import { WorkflowController } from "../../src/workflows/runtime/controller.ts"
import { saveWorkflowAtomic, type SaveFs } from "../../src/workflows/runtime/save.ts"
import { runWorkflow } from "../../src/workflows/runner.ts"
import type { WorkflowRunDeps } from "../../src/workflows/runner.ts"

export const SOURCE = `export const meta = { name: "demo", description: "demo workflow", phases: [{ title: "p1" }] }
agent("do something")
`

export const ONE_AGENT = `export const meta = { name: "demo", description: "one agent", phases: [{ title: "p1" }] }
agent("do something")
`

export const TWO_AGENTS = `export const meta = { name: "demo", description: "two agents", phases: [{ title: "p1" }] }
await agent("first")
await agent("second")
`

export const CHECKPOINT_SCRIPT = `export const meta = { name: "demo", description: "checkpoint", phases: [{ title: "p1" }] }
await agent("first")
await checkpoint("approve the first result")
await agent("second")
`

export const ORIGINAL_SOURCE = `export const meta = { name: "demo", description: "original", phases: [{ title: "p1" }] }
agent("original")
`

export const EDITED_SOURCE = `export const meta = { name: "demo", description: "edited", phases: [{ title: "p1" }] }
agent("edited")
`

export const PROJECT_SOURCE = `export const meta = { name: "code-review", description: "project workflow", phases: [{ title: "review" }] }
agent("review the code")
`

export const UPDATED_SOURCE = `export const meta = { name: "code-review", description: "updated project workflow", phases: [{ title: "review" }] }
agent("review the updated code")
`

let runIdCounter = 0
function nextRunId(): string {
  runIdCounter++
  return `wf-${runIdCounter}`
}

export function completed(runId: string): WorkflowRunResult {
  return {
    runId,
    status: "completed",
    result: undefined,
    phases: [],
    childRunIds: [],
    logs: [],
    tokenTotal: 0,
    costTotal: 0,
  }
}

export function child(
  finalText: string,
  runId = "fl-child",
): { finalText: string; runId: string; status: "completed"; tokenTotal: number; costTotal: number } {
  return { finalText, runId, status: "completed", tokenTotal: 10, costTotal: 0.1 }
}

export interface ControllerFixtureOptions {
  runWorkflow?: (
    script: string,
    opts: import("../../src/workflows/runner.ts").WorkflowRunOpts,
    deps: import("../../src/workflows/runner.ts").WorkflowRunDeps,
  ) => Promise<WorkflowRunResult>
  spawn?: (
    prompt: string,
    opts: { agent: string; model?: string; tier?: string; lifecycle?: string; isolation?: "worktree"; skills?: string[]; backend?: "pi" | "claude"; timeoutMs?: number; runId: string; signal?: AbortSignal },
  ) => Promise<{ finalText: string; runId: string; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number }>
  projectDir?: string
}

export interface ControllerFixture {
  controller: WorkflowController
  store: WorkflowRunStore
  inbox: ResultsInbox
  journal: WorkflowJournal
  registry: WorkflowRegistry
  cleanup: () => void
}

export function controllerFixture(opts: ControllerFixtureOptions = {}): ControllerFixture {
  const tmpDirs: string[] = []
  const journalDir = mkdtempSync(join(tmpdir(), "wf-journal-"))
  tmpDirs.push(journalDir)
  const projectDir = opts.projectDir ?? mkdtempSync(join(tmpdir(), "wf-project-"))
  if (!opts.projectDir) tmpDirs.push(projectDir)

  const journal = new WorkflowJournal(journalDir)
  const store = new WorkflowRunStore()
  const inbox = new ResultsInbox()
  const demoDef: import("../../src/workflows/registry.ts").WorkflowDef = {
    name: "demo",
    description: "demo workflow",
    phases: [{ title: "p1" }],
    sourceText: SOURCE,
    body: 'agent("do something")',
    executable: 'module.exports = (async () => {\nagent("do something")\n})()',
    source: "builtin",
    filePath: "builtin/demo.js",
  }
  const registry = new WorkflowRegistry(new Map([["demo", demoDef]]))

  const defaultRunWorkflow: typeof import("../../src/workflows/runner.ts").runWorkflow = async (
    _script,
    runOpts,
  ) => completed(runOpts.runId ?? nextRunId())

  // When spawn is provided, build real runDeps + use the real runWorkflow.
  let realRunDeps: WorkflowRunDeps | undefined
  if (opts.spawn) {
    realRunDeps = {
      spawn: opts.spawn,
      worktree: {
        isGitRepo: () => false,
        create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }),
        removeWorktree: () => {},
        remove: () => {},
      },
      tierRegistry: { get: () => undefined },
      journal,
      runRegistry: { get: () => undefined, list: () => [] },
      genRunId: nextRunId,
      notify: () => {},
      resolveWorkflow: () => undefined,
    } as WorkflowRunDeps
  }

  const controller = new WorkflowController({
    registry,
    projectDir,
    store,
    journal,
    runWorkflow: opts.runWorkflow ?? (opts.spawn ? runWorkflow : defaultRunWorkflow),
    runDepsFactory: () => (realRunDeps ?? ({} as WorkflowRunDeps)),
    inbox,
    genRunId: nextRunId,
    notify: () => {},
  })

  return {
    controller,
    store,
    inbox,
    journal,
    registry,
    cleanup: () => {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    },
  }
}

export function fakeController(
  overrides: Partial<import("../../src/workflows/runtime/controller.ts").WorkflowControllerDeps> = {},
): WorkflowController {
  const journal = new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-fake-")))
  const store = new WorkflowRunStore()
  const inbox = new ResultsInbox()
  const registry = new WorkflowRegistry(new Map())
  return new WorkflowController({
    registry,
    projectDir: mkdtempSync(join(tmpdir(), "wf-fake-")),
    store,
    journal,
    runWorkflow: async (_s, o) => completed(o.runId ?? "wf-fake"),
    runDepsFactory: () => ({}) as import("../../src/workflows/runner.ts").WorkflowRunDeps,
    inbox,
    genRunId: () => "wf-fake",
    notify: () => {},
    ...overrides,
  })
}

export function execute(
  controller: WorkflowController,
  state: WorkflowRunState,
  executable: string,
  input: import("../../src/workflows/runtime/types.ts").WorkflowStartInput,
): Promise<WorkflowRunResult> {
  return (controller as unknown as {
    execute: (
      state: WorkflowRunState,
      executable: string,
      input: import("../../src/workflows/runtime/types.ts").WorkflowStartInput,
    ) => Promise<WorkflowRunResult>
  }).execute(state, executable, input)
}

export function started(runId: string, name: string): WorkflowRunState {
  return {
    runId,
    name,
    script: "",
    mode: "auto",
    status: "running",
    startedAt: Date.now(),
    currentPhase: "default",
    phases: [],
    childRunIds: [],
    logs: [],
    tokenTotal: 0,
    costTotal: 0,
  }
}

export function progress(
  runId: string,
  name: string,
  phase: string,
): import("../../src/workflows/runtime/types.ts").WorkflowProgressEvent {
  return {
    kind: "phase",
    runId,
    snapshot: {
      ...started(runId, name),
      currentPhase: phase,
    },
  }
}

export function completedEvent(
  runId: string,
  name: string,
): import("../../src/workflows/runtime/types.ts").WorkflowProgressEvent {
  return {
    kind: "completed",
    runId,
    snapshot: {
      ...started(runId, name),
      status: "completed",
    },
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

export interface AtomicSaveFixture {
  saveFixture: (input: {
    name: string
    source: string
    overwrite?: boolean
  }) => void
  targetPath: string
  cleanup: () => void
}

export function atomicSaveFixture(opts: { renameError?: Error } = {}): AtomicSaveFixture {
  const dir = mkdtempSync(join(tmpdir(), "wf-atomic-"))
  const targetPath = join(dir, "code-review.js")

  const fakeFs: SaveFs = {
    existsSync: (p: string) => existsSync(p),
    mkdirSync: (p: string, _o: { recursive: boolean }) => mkdirSync(p, _o),
    openSync: (p: string, flags: string) => openSync(p, flags),
    writeSync: (fd: number, data: string) => writeSync(fd, data),
    closeSync: (fd: number) => closeSync(fd),
    renameSync: (_old: string, _new: string) => {
      if (opts.renameError) throw opts.renameError
      renameSync(_old, _new)
    },
    unlinkSync: (p: string) => {
      try {
        rmSync(p, { force: true })
      } catch {
        // best-effort
      }
    },
    readdirSync: (p: string) => readdirSync(p),
    readFileSync: (p: string) => readFileSync(p, "utf8"),
    writeFileSync: (p: string, content: string) => writeFileSync(p, content, "utf8"),
  }

  return {
    saveFixture: (input) => {
      saveWorkflowAtomic({ ...input, dir }, fakeFs)
    },
    targetPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export { WorkflowController }
