// SPEC-6-3 §3.8 — pure fn for the Workflows view rows. Unit-tested; the panel class is term-smoke-gated.
import type { SelectItem } from "@earendil-works/pi-tui";

export interface WorkflowRunRow {
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "aborted" | "paused" | "checkpoint";
  currentPhase: string;
  phases: { title: string }[];
  agents: number;
  cached: number;
  reRun: number;
  tokens: number;
  cost: number;
}

const GLYPH: Record<WorkflowRunRow["status"], string> = {
  running: "▶", completed: "✓", failed: "✗", aborted: "✗", paused: "⏸", checkpoint: "⏸",
};

function phaseStrip(phases: { title: string }[], current: string): string {
  return phases.map((p) => p.title === current ? `${p.title} ▶` : `${p.title} ○`).join(" ");
}

export function buildWorkflowsItems(runs: WorkflowRunRow[]): SelectItem[] {
  return runs.map((r) => ({
    id: r.runId,
    label: `${GLYPH[r.status]} ${r.name}  [${r.status}]  ${phaseStrip(r.phases, r.currentPhase)} · ${r.agents} agents (${r.cached} cached, ${r.reRun} re-run) · ${(r.tokens / 1000).toFixed(1)}K tok · $${r.cost.toFixed(2)}`,
    value: r.runId,
  }));
}
