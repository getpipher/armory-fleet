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
