// src/panel/rows.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { RunRecord } from "../engine/run-registry.ts";

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

const STATUS_GLYPH: Record<FleetRunStatus, string> = {
  running: "▶",
  completed: "✓",
  failed: "✗",
  aborted: "✗",
};

export function fleetRow(run: RunRecord, ctxPercent?: number): string {
  const dur = run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : "—";
  const todo = run.todoId ? `  ${run.todoId}` : "";
  const summary = run.resultSummary ? `  "${run.resultSummary}"` : "";
  const ctx = ctxPercent !== undefined ? `  ${ctxPercent}% ctx` : "";
  return `${STATUS_GLYPH[run.status]} ${run.runId}  ${run.agent}  ${run.status}  ${dur}${ctx}${todo}${summary}`;
}

export function agentsRow(agent: AgentDef): string {
  const model = agent.model ?? "(default)";
  const chip = `armory:[t${agent.todoSync ? "✓" : "✗"} m${agent.memoryHydrate ? "✓" : "✗"} v${agent.vision ? "✓" : "✗"}]`;
  const skills = agent.skills?.length ? `  skills: ${agent.skills.join(",")}` : "";
  const tools = agent.tools?.length ? `  tools: ${agent.tools.join(",")}` : "";
  return `${agent.name}  [${agent.source}]  ${model}${tools}${skills}  ${chip}`;
}

export function agentInfo(agent: AgentDef): string {
  const lines = [
    `name: ${agent.name}`,
    `source: ${agent.source}`,
    `model: ${agent.model ?? "(default)"}`,
    `thinkingLevel: ${agent.thinkingLevel ?? "(model default)"}`,
    `tools: ${agent.tools?.length ? agent.tools.join(", ") : "(pi default)"}`,
    `skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`,
    `todoSync: ${agent.todoSync ? "✓" : "✗"}`,
    `memoryHydrate: ${agent.memoryHydrate ? "✓" : "✗"}`,
    `vision: ${agent.vision ? "✓" : "✗"}`,
    `file: ${agent.filePath}`,
    "",
    "── role prompt ──",
    agent.rolePrompt.trim(),
  ];
  return lines.join("\n");
}