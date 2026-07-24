// src/panel/rows.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { RunRecord } from "../engine/run-registry.ts";
import type { Backend, BackendHookParity } from "../backend/port.ts";

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
  return `${agent.name}  [${agent.backend}]  [${agent.source}]  ${model}${tools}${skills}  ${chip}`;
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
function chipStr(p: BackendHookParity): string {
  return `t${p.todo} m${p.memory} v${p.vision}`;
}

export function backendsRow(b: Backend): string {
  const avail = b.available() ? "✓" : "✗";
  const vi = b.versionInfo();
  const version = vi?.version ? vi.version : "—";
  const schema = vi ? (vi.schemaOk ? "✓" : "✗") : "—";
  const note = vi && !vi.schemaOk && vi.note ? `  ${vi.note}` : "";
  return `${b.id}  ${avail}  ${version}  schema:${schema}  armory:[${chipStr(b.hookParity)}]${note}`;
}

export function backendInfo(b: Backend): string {
  const vi = b.versionInfo();
  const lines = [
    `id: ${b.id}`,
    `available: ${b.available() ? "✓" : "✗"}`,
    `version: ${vi?.version ?? "—"}`,
    `schemaOk: ${vi ? vi.schemaOk : "—"}`,
  ];
  if (vi?.note) lines.push(`note: ${vi.note}`);
  lines.push("flagSupport:");
  for (const [flag, ok] of Object.entries(vi?.flagSupport ?? {})) lines.push(`  ${flag}: ${ok ? "✓" : "✗"}`);
  lines.push("hookParity:");
  lines.push(`  todo: ${b.hookParity.todo}  (excluded via ${b.id === "pi" ? "excludeTools+noExtensions" : "--disallowed-tools/prompt-nudge"})`);
  lines.push(`  memory: ${b.hookParity.memory}  (${b.id === "pi" ? "CustomResourceLoader systemPromptOverride" : "--append-system-prompt"})`);
  lines.push(`  vision: ${b.hookParity.vision}  (${b.hookParity.vision === "✓" ? "describe_image fallback injected" : "pass-through only; no describe_image fallback — customTools not injectable into claude -p"})`);
  return lines.join("\n");
}
