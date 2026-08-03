import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { WorkflowDef } from "../../src/workflows/registry.ts"
import type { WorkflowRunState } from "../../src/workflows/runtime/types.ts"
import { WorkflowRunStore } from "../../src/workflows/runtime/run-store.ts"
import { WorkflowRegistry } from "../../src/workflows/registry.ts"
import { FleetPanel } from "../../src/panel/fleet-panel.ts"

// ── Factories ──

export function definition(source: "builtin" | "global" | "project", name: string): WorkflowDef {
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

export function run(runId: string, status: WorkflowRunState["status"], startedAt: number): WorkflowRunState {
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

export function runningRun(): WorkflowRunState {
  return run("wf-1", "running", 100)
}

export function pausedRun(): WorkflowRunState {
  return run("wf-1", "paused", 100)
}

// ── Strip ANSI ──

const ANSI_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

// ── Minimal structural Theme fake ──

function fakeTheme(): Theme {
  const id = (_color: string, s: string): string => s
  return {
    fg: id,
    bg: id,
    bold: id,
    dim: id,
    italic: id,
    underline: id,
    getFgAnsi: () => "",
    getColorMode: () => "truecolor" as never,
  } as unknown as Theme
}

// ── Recording fake controller ──

interface RecordingController {
  calls: string[][]
  pause(runId: string): void
  resume(runId: string): Promise<unknown>
  stop(runId: string): Promise<void>
  getRun(runId: string): WorkflowRunState | undefined
  runs(): WorkflowRunState[]
  definitions(): WorkflowDef[]
  hydrate(): void
}

function recordingController(store: WorkflowRunStore): RecordingController {
  const calls: string[][] = []
  return {
    calls,
    pause: (runId: string) => { calls.push(["pause", runId]) },
    resume: async (runId: string) => { calls.push(["resume", runId]); return { runId, status: "background" as const } },
    stop: async (runId: string) => { calls.push(["stop", runId]) },
    getRun: (runId: string) => store.get(runId),
    runs: () => store.values(),
    definitions: () => [],
    hydrate: () => {},
  }
}

// ── Panel fixture ──

export interface PanelFixture {
  panel: FleetPanel
  store: WorkflowRunStore
  registry: WorkflowRegistry
  controller: RecordingController
  renderCount: () => number
  cleanup: () => void
}

export function panelFixture(opts: { selected?: WorkflowRunState } = {}): PanelFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "wf-panel-"))
  const store = new WorkflowRunStore()
  const registry = new WorkflowRegistry(new Map([
    ["code-review", definition("builtin", "code-review")],
  ]))
  const controller = recordingController(store)

  if (opts.selected) {
    store.set(opts.selected.runId, opts.selected)
  }

  let renderCount = 0
  let unsub: (() => void) | null = null

  const panel = new FleetPanel({
    theme: fakeTheme(),
    deps: {
      // Minimal required deps — the panel only uses these in the Workflows view;
      // other views need more but we only test Workflows.
      registry: new Map(),
      runRegistry: {
        subscribe: () => () => {},
        get: () => undefined,
        list: () => [],
      } as never,
      lock: { acquire: () => {}, release: () => {} } as never,
      todoSync: {} as never,
      backendRegistry: { list: () => [], get: () => undefined } as never,
      parentModel: { provider: "", id: "" },
      parentCwd: "",
      lifecycleRegistry: new Map(),
      lifecycleRuns: new Map(),
      lifecycleDeps: {} as never,
      workflowController: controller as never,
      workflowStore: store,
      workflowRegistry: registry,
    },
    onDone: () => {},
    onNotify: () => {},
  })

  // Track renderCount via the panel's invalidate
  const origInvalidate = panel.invalidate.bind(panel)
  panel.invalidate = () => { renderCount++; origInvalidate() }

  return {
    panel,
    store,
    registry,
    controller,
    renderCount: () => renderCount,
    cleanup: () => { rmSync(tmpDir, { recursive: true, force: true }) },
  }
}

export function openWorkflows(panel: FleetPanel): void {
  // Tab through: fleet → lifecycle → runs → agents → backends → scheduled → tiers → workflows
  for (let i = 0; i < 7; i++) panel.handleInput("\t")
}

// ── Host test helpers (Task 12) ──

export const ORIGINAL_SOURCE = `export const meta = { name: "demo", description: "original" }
agent("original")
`
export const EDITED_SOURCE = `export const meta = { name: "demo", description: "edited" }
agent("edited")
`

export function terminalRun(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "wf-old",
    name: "demo",
    script: ORIGINAL_SOURCE,
    mode: "auto",
    status: "completed",
    startedAt: 100,
    currentPhase: "default",
    phases: [],
    childRunIds: [],
    logs: [],
    tokenTotal: 0,
    costTotal: 0,
    result: undefined,
    ...overrides,
  }
}

export interface HostFakeController {
  calls: unknown[][]
  saveCollision: boolean
  start(input: unknown): Promise<unknown>
  editAndResume(runId: string, source: string, mode?: string): Promise<unknown>
  save(input: { name: string; source: string; overwrite?: boolean }): unknown
  getRun(runId: string): WorkflowRunState | undefined
  definitions(): WorkflowDef[]
  respondToCheckpoint(runId: string, response: unknown): void
  pause(runId: string): void
  resume(runId: string): Promise<unknown>
  stop(runId: string): Promise<void>
  runs(): WorkflowRunState[]
  hydrate(): void
}

export function fakeController(opts: {
  getRun?: (runId: string) => WorkflowRunState | undefined
  saveCollision?: boolean
  definitions?: () => WorkflowDef[]
} = {}): HostFakeController {
  const calls: unknown[][] = []
  const defs = opts.definitions ?? (() => [definition("builtin", "code-review")])
  return {
    calls,
    saveCollision: opts.saveCollision ?? false,
    start: async (input: unknown) => { calls.push(["start", input]); return { runId: "wf-new", status: "background" as const } },
    editAndResume: async (runId: string, source: string, mode?: string) => {
      calls.push(["editAndResume", runId, source, mode ?? "checkpointed"])
      return { runId: "wf-new", status: "background" as const }
    },
    save: (input: { name: string; source: string; overwrite?: boolean }) => {
      calls.push(["save", input])
      return definition("project", input.name)
    },
    getRun: opts.getRun ?? ((runId: string) => undefined),
    definitions: defs,
    respondToCheckpoint: (runId: string, response: unknown) => { calls.push(["respondToCheckpoint", runId, response]) },
    pause: (runId: string) => { calls.push(["pause", runId]) },
    resume: async (runId: string) => { calls.push(["resume", runId]); return { runId, status: "background" as const } },
    stop: async (runId: string) => { calls.push(["stop", runId]) },
    runs: () => [],
    hydrate: () => {},
  }
}

export interface FakeUiQueueItem {
  type: "custom" | "editor" | "input" | "confirm"
  value: unknown
}

export interface FakeUi {
  customCount: number
  sentUserMessages: string[]
  notifies: string[]
  custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => void
  editor: (initial: string) => Promise<string>
  input: (prompt: string) => Promise<string>
  confirm: (prompt: string) => Promise<boolean>
  notify: (msg: string, type?: "info" | "warning" | "error") => void
  sendUserMessage: (text: string) => void
}

export function fakeUi(queue: FakeUiQueueItem[]): FakeUi {
  let idx = 0
  const customCount = { v: 0 }
  const sentUserMessages: string[] = []
  const notifies: string[] = []

  const next = (type: string): unknown => {
    if (idx >= queue.length) throw new Error(`fakeUi: unexpected ${type} call (queue exhausted)`)
    const item = queue[idx]!
    idx++
    if (item.type !== type) throw new Error(`fakeUi: expected ${type} but got ${item.type}`)
    return item.value
  }

  return {
    customCount: 0,
    sentUserMessages,
    notifies,
    custom: (factory) => {
      customCount.v++
      const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (_c: string, s: string) => s, dim: (_c: string, s: string) => s, italic: (_c: string, s: string) => s, underline: (_c: string, s: string) => s, getFgAnsi: () => "", getColorMode: () => "truecolor" as never } as never
      const intent = next("custom")
      const done = () => {}
      const panel = factory(undefined, theme, undefined, done) as unknown as {
        onDone: (intent: unknown) => void
        close: (intent?: unknown) => void
      }
      // Simulate the panel closing with the queued intent
      queueMicrotask(() => panel.close(intent))
    },
    editor: async (_initial: string) => next("editor") as string,
    input: async (_prompt: string) => next("input") as string,
    confirm: async (_prompt: string) => next("confirm") as boolean,
    notify: (msg: string) => { notifies.push(msg) },
    sendUserMessage: (text: string) => { sentUserMessages.push(text) },
  }
}

export function context(ui: FakeUi): import("../../src/workflows/panel-host.ts").WorkflowPanelHostContext {
  return {
    custom: ui.custom as never,
    editor: ui.editor as never,
    input: ui.input as never,
    confirm: ui.confirm as never,
    notify: ui.notify as never,
    sendUserMessage: ui.sendUserMessage,
  }
}

export function panelDeps(controller: HostFakeController): import("../../src/panel/fleet-panel.ts").FleetPanelDeps {
  const store = new WorkflowRunStore()
  const registry = new WorkflowRegistry(new Map([
    ["code-review", definition("builtin", "code-review")],
  ]))
  return {
    registry: new Map(),
    runRegistry: { subscribe: () => () => {}, get: () => undefined, list: () => [] } as never,
    lock: { acquire: () => {}, release: () => {} } as never,
    todoSync: {} as never,
    backendRegistry: { list: () => [], get: () => undefined } as never,
    parentModel: { provider: "", id: "" },
    parentCwd: "",
    lifecycleRegistry: new Map(),
    lifecycleRuns: new Map(),
    lifecycleDeps: {} as never,
    workflowController: controller as never,
    workflowStore: store,
    workflowRegistry: registry,
  } as never
}
