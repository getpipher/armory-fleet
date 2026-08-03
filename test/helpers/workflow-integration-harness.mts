import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { WorkflowJournal } from "../../src/workflows/journal.ts"
import { WorkflowRunStore } from "../../src/workflows/runtime/run-store.ts"
import { WorkflowRegistry, discoverWorkflows } from "../../src/workflows/registry.ts"
import { WorkflowController } from "../../src/workflows/runtime/controller.ts"
import { ResultsInbox } from "../../src/runtime/results-inbox.ts"
import { runWorkflow, type WorkflowRunDeps } from "../../src/workflows/runner.ts"
import type { WorkflowRunResult } from "../../src/workflows/runner.ts"

export const BUILTIN_DIR = join(process.cwd(), "src", "workflows", "builtin")

export const BUILTIN_NAMES = [
  "code-review",
  "deep-research",
  "adversarial-review",
  "multi-perspective",
  "codebase-audit",
] as const

export const LIFECYCLE_SCRIPT = `export const meta = { name: "lc-test", description: "lifecycle test", phases: [{ title: "do" }] }
await agent("do the thing", { lifecycle: "default" })
return "lifecycle done"
`

export const THREE_PARALLEL = `export const meta = { name: "par-test", description: "parallel test", phases: [{ title: "p" }] }
await parallel([() => agent("a"), () => agent("b"), () => agent("c")])
return "done"
`

let childCounter = 0

function routePrompt(prompt: string): string {
  if (/Find unique sources/i.test(prompt) || /Return a JSON array of source strings/i.test(prompt)) {
    return JSON.stringify(["source-1", "source-2"])
  }
  if (/List files/i.test(prompt) || /Return a JSON array of file path strings/i.test(prompt)) {
    return JSON.stringify(["file-a.js", "file-b.js"])
  }
  if (/independent reviewer/i.test(prompt) || /REAL\/valid/i.test(prompt) || /real or fake/i.test(prompt)) {
    return "real: confirmed"
  }
  if (/judge/i.test(prompt) || /Score this attempt/i.test(prompt)) {
    return JSON.stringify({ score: 8, reason: "sound" })
  }
  if (/synthe/i.test(prompt) || /revise/i.test(prompt) || /summary/i.test(prompt)) {
    return "x".repeat(130)
  }
  return "ok-" + prompt.slice(0, 8)
}

export interface HarnessOptions {
  builtinDir?: string
  measuredSpawn?: boolean
  projectDir?: string
}

export interface IntegrationHarness {
  controller: WorkflowController
  store: WorkflowRunStore
  registry: WorkflowRegistry
  journal: WorkflowJournal
  inbox: ResultsInbox
  runRegistry: {
    get: (runId: string) => { runId: string; agent: string; status: string; todoId: string | null; cwd: string; backend: string } | undefined
    list: () => Array<{ runId: string; agent: string; status: string; todoId: string | null; cwd: string; backend: string; costTotal?: number; tokenTotal?: number }>
    set: (runId: string, record: { runId: string; agent: string; status: string; todoId: string | null; cwd: string; backend: string; costTotal?: number; tokenTotal?: number }) => void
    subscribe: (fn: () => void) => () => void
  }
  maxActiveChildren: number
  cleanup: () => void
}

export async function createWorkflowIntegrationHarness(opts: HarnessOptions = {}): Promise<IntegrationHarness> {
  const builtinDir = opts.builtinDir ?? BUILTIN_DIR
  const tmpDirs: string[] = []
  const journalDir = mkdtempSync(join(tmpdir(), "wf-int-journal-"))
  tmpDirs.push(journalDir)
  const projectDir = opts.projectDir ?? mkdtempSync(join(tmpdir(), "wf-int-project-"))
  if (!opts.projectDir) tmpDirs.push(projectDir)

  const journal = new WorkflowJournal(journalDir)
  const store = new WorkflowRunStore()
  const inbox = new ResultsInbox()

  const discovery = discoverWorkflows({
    builtinDir,
    globalDir: "",
    projectDir,
  })
  const registry = new WorkflowRegistry(discovery.workflows)

  // Fake run registry
  const runRecords = new Map<string, { runId: string; agent: string; status: string; todoId: string | null; cwd: string; backend: string; costTotal?: number; tokenTotal?: number }>()
  const runRegistry = {
    get: (runId: string) => runRecords.get(runId),
    list: () => [...runRecords.values()],
    set: (runId: string, record: { runId: string; agent: string; status: string; todoId: string | null; cwd: string; backend: string; costTotal?: number; tokenTotal?: number }) => {
      runRecords.set(runId, record)
    },
    subscribe: (_fn: () => void) => () => {},
  }

  let active = 0
  let maxActive = 0
  childCounter = 0

  const maxActiveRef = { v: 0 }

  const fakeTierRegistry = {
    get: (_name: string) => ({ models: ["pi/default"], costCap: 1_000_000, contextFloor: 0 }),
  }

  const fakeWorktree = {
    isGitRepo: () => false,
    create: (id: string) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }),
    removeWorktree: () => {},
    remove: () => {},
  }

  const runDepsFactory = (runId: string): WorkflowRunDeps => ({
    spawn: async (prompt: string, spawnOpts: { agent: string; model?: string; tier?: string; lifecycle?: string; skills?: string[]; backend?: "pi" | "claude"; timeoutMs?: number; runId: string }) => {
      active++
      maxActive = Math.max(maxActive, active)
      maxActiveRef.v = Math.max(maxActiveRef.v, active)
      // Small delay so parallel calls actually overlap (concurrency clamp visible)
      await new Promise((r) => setTimeout(r, 10))
      const childRunId = "fl-" + (++childCounter).toString(36)
      const finalText = routePrompt(prompt)
      const status: "completed" | "failed" = "completed"
      runRegistry.set(childRunId, {
        runId: childRunId,
        agent: spawnOpts.agent,
        status,
        todoId: null,
        cwd: process.cwd(),
        backend: "pi",
        costTotal: 0.01,
        tokenTotal: 10,
      })
      active--
      return { finalText, runId: childRunId, status, costTotal: 0.01, tokenTotal: 10 }
    },
    runLifecycle: async (_task: string, _name: string, _lcOpts: { mode: string; worktreePath?: string }) => {
      return { status: "completed" as const, finalText: "lifecycle done", costTotal: 0.1, tokenTotal: 5 }
    },
    worktree: fakeWorktree as never,
    tierRegistry: fakeTierRegistry as never,
    journal,
    runRegistry: runRegistry as never,
    genRunId: () => "wf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: (name: string) => {
      const def = registry.get(name)
      return def ? { sourceText: def.sourceText, executable: def.executable } : undefined
    },
  })

  const controller = new WorkflowController({
    registry,
    projectDir,
    store,
    journal,
    runWorkflow,
    runDepsFactory,
    inbox,
    genRunId: () => "wf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
  })

  controller.hydrate()

  return {
    controller,
    store,
    registry,
    journal,
    inbox,
    runRegistry: runRegistry as never,
    get maxActiveChildren() { return maxActiveRef.v },
    cleanup: () => {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    },
  }
}

// Re-export for tests that need maxActiveChildren live (not snapshot)
export function getMaxActiveChildren(): number {
  return 0 // placeholder — tests read app.maxActiveChildren after runs complete
}
