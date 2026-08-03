// SPEC-6-3 §7/§10 — combined Workflows panel item + action model (pure functions).
// Definitions first (sorted by source rank, then name), then runs (newest-first).
import type { SelectItem } from "@earendil-works/pi-tui"

import type { WorkflowDef } from "../registry.ts"
import type { WorkflowRunState } from "../runtime/types.ts"

export type WorkflowPanelItem =
  | { kind: "definition"; definition: WorkflowDef }
  | { kind: "run"; run: WorkflowRunState }

export type WorkflowPanelAction =
  | "run"
  | "open"
  | "pause"
  | "resume"
  | "stop"
  | "save"
  | "respond"
  | "edit-resume"
  | "view-result"
  | "resume-unchanged"

const SOURCE_RANK: Record<WorkflowDef["source"], number> = {
  project: 0,
  global: 1,
  builtin: 2,
}

const RUN_STATUS_GLYPH: Record<WorkflowRunState["status"], string> = {
  queued: "○",
  running: "▶",
  paused: "⏸",
  checkpoint: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "✗",
  interrupted: "⚠",
}

const DESC_BOUND = 80
const LOG_BOUND = 120

function bound(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

function phaseStrip(phases: { title: string }[], current: string): string {
  return phases.map((p) => (p.title === current ? `${p.title} ▶` : `${p.title} ○`)).join(" ")
}

function definitionLabel(def: WorkflowDef): string {
  const desc = def.description ? ` — ${bound(def.description, DESC_BOUND)}` : ""
  return `◇ ${def.name}  [${def.source}]${desc}`
}

function runLabel(state: WorkflowRunState): string {
  const glyph = RUN_STATUS_GLYPH[state.status]
  const strip = state.phases.length > 0 ? `  ${phaseStrip(state.phases, state.currentPhase)}` : ""
  const tokens = state.tokenTotal > 0 ? ` · ${(state.tokenTotal / 1000).toFixed(1)}K tok` : ""
  const cost = state.costTotal > 0 ? ` · $${state.costTotal.toFixed(2)}` : ""
  const lastLog = state.logs.length > 0 ? `  ${bound(state.logs.at(-1) ?? "", LOG_BOUND)}` : ""
  return `${glyph} ${state.runId}  [${state.status}]${strip}${tokens}${cost}${lastLog}`
}

export function buildWorkflowPanelItems(input: {
  definitions: WorkflowDef[]
  runs: WorkflowRunState[]
}): SelectItem[] {
  const sortedDefs = [...input.definitions].sort((a, b) => {
    const rankDiff = SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    if (rankDiff !== 0) return rankDiff
    return a.name.localeCompare(b.name)
  })

  const sortedRuns = [...input.runs].sort((a, b) => b.startedAt - a.startedAt)

  const defItems: SelectItem[] = sortedDefs.map((def) => ({
    value: `definition:${def.name}`,
    label: definitionLabel(def),
  }))

  const runItems: SelectItem[] = sortedRuns.map((r) => ({
    value: `run:${r.runId}`,
    label: runLabel(r),
  }))

  return [...defItems, ...runItems]
}

export function actionsForWorkflowItem(item: WorkflowPanelItem): WorkflowPanelAction[] {
  if (item.kind === "definition") {
    return ["run", "open"]
  }

  const status = item.run.status
  switch (status) {
    case "queued":
      return ["open", "stop"]
    case "running":
      return ["open", "pause", "stop", "save"]
    case "paused":
      return ["open", "resume", "stop", "save"]
    case "checkpoint":
      return ["respond", "stop", "open"]
    case "completed":
      return ["open", "edit-resume", "save", "view-result"]
    case "failed":
      return ["open", "edit-resume", "save", "view-result"]
    case "aborted":
      return ["open", "edit-resume", "save", "view-result"]
    case "interrupted":
      return ["open", "edit-resume", "resume-unchanged", "stop", "save"]
  }
}

export function parseWorkflowPanelKey(
  value: string,
): { kind: "definition"; name: string } | { kind: "run"; runId: string } {
  if (value.startsWith("definition:")) {
    return { kind: "definition", name: value.slice("definition:".length) }
  }
  if (value.startsWith("run:")) {
    return { kind: "run", runId: value.slice("run:".length) }
  }
  throw new Error(`invalid workflow panel key: ${value}`)
}

// ── Backward-compat shim (Task 12 will rewire the panel to the new model) ──

export interface WorkflowRunRow {
  runId: string
  name: string
  status: "running" | "completed" | "failed" | "aborted" | "paused" | "checkpoint"
  currentPhase: string
  phases: { title: string }[]
  agents: number
  cached: number
  reRun: number
  tokens: number
  cost: number
}

export function buildWorkflowsItems(runs: WorkflowRunRow[]): SelectItem[] {
  return runs.map((r) => ({
    id: r.runId,
    label: `${RUN_STATUS_GLYPH[r.status] ?? "▶"} ${r.name}  [${r.status}]  ${phaseStrip(r.phases, r.currentPhase)} · ${r.agents} agents (${r.cached} cached, ${r.reRun} re-run) · ${(r.tokens / 1000).toFixed(1)}K tok · $${r.cost.toFixed(2)}`,
    value: r.runId,
  }))
}
