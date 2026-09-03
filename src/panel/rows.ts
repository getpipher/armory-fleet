// src/panel/rows.ts
import { basename } from "node:path";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { RunRecord } from "../engine/run-registry.ts";
import type { Backend, BackendHookParity } from "../backend/port.ts";
import { fg as statusFg, type FgTheme } from "../present/tokens.ts";

/** Structural theme for row colorization (pi's Theme satisfies it; omit → plain text). */
export type RowTheme = FgTheme;

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** Compact token count: <1K as-is, >=1K with K suffix (1 decimal under 10K, 0 decimals above).
 *  142 → "142"; 1300 → "1.3K"; 265055 → "265K"; 2027001 → "2027K". */
export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)}K`;
}

const STATUS_GLYPH: Record<FleetRunStatus, string> = {
  running: "▶",
  completed: "✓",
  failed: "✗",
  aborted: "✗",
};

export function fleetRow(run: RunRecord, ctxPercent?: number, theme?: RowTheme): string {
  const dur = run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : "—";
  const todo = run.todoId ? `  ${run.todoId}` : "";
  const summary = run.resultSummary ? `  "${run.resultSummary}"` : "";
  const ctx = ctxPercent !== undefined ? `  ${ctxPercent}% ctx` : "";
  const glyph = theme ? statusFg(run.status, theme, STATUS_GLYPH[run.status]) : STATUS_GLYPH[run.status];
  const status = theme ? statusFg(run.status, theme, run.status) : run.status;
  return `${glyph} ${run.runId}  ${run.agent}  ${status}  ${dur}${ctx}${todo}${summary}`;
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

import type { LifecycleRunRecord, LifecycleStatus } from "../lifecycle/lifecycle-types.ts";
import { buildGateLine } from "./gate-line.ts";


// SPEC-5a §11 — bg run row status (Q8=A). The fleet tab gains live status icons + phase progress
// for async/bg runs; foreground rows are unchanged.
export type BgStatus = "running" | "paused" | "completed" | "failed" | "queued";

export interface BgRunStatus {
  runId: string;
  lifecycle: string;
  status: BgStatus;
  phase: string;
  phaseIndex: number;
  phaseTotal: number;
  mode: "auto" | "checkpointed";
  backend: string;
  task: string;
  branch?: string;
  elapsedMs?: number;
}

export function bgStatusIcon(s: BgStatus): string {
  switch (s) {
    case "running": return "▶";
    case "paused": return "⏸";
    case "completed": return "✓";
    case "failed": return "✗";
    case "queued": return "⏳";
  }
}

export function renderBgRow(r: BgRunStatus, theme?: RowTheme): string {
  const rawIcon = bgStatusIcon(r.status);
  const icon = theme ? statusFg(r.status, theme, rawIcon) : rawIcon;
  const phase = r.phase ? `●${r.phase} ${r.phaseIndex}/${r.phaseTotal}` : `${r.phaseIndex}/${r.phaseTotal}`;
  const branch = r.branch ? `  ${r.branch}` : "";
  const elapsed = r.elapsedMs ? `  ${fmtDuration(r.elapsedMs)}` : "";
  const task = r.task.length > 30 ? r.task.slice(0, 29) + "…" : r.task;
  return `${icon} ${r.runId}  ${r.lifecycle}  ${phase}  ${r.mode}${elapsed}  ${r.backend}${branch}  "${task}"`;
}

// SPEC-5a §11 — scheduled tab row rendering.
export interface ScheduleRow {
  id: string;
  expression: string;
  lifecycle?: string;
  task: string;
  nextFire: Date | null;
  paused: boolean;
  /** #62: pinned dispatch cwd — rendered as a ↗ basename so cross-cwd schedules are visible. */
  cwd?: string;
}

export function scheduleRow(s: ScheduleRow, theme?: RowTheme): string {
  const rawIcon = s.paused ? "⏸" : "▶";
  const icon = theme ? statusFg(s.paused ? "paused" : "running", theme, rawIcon) : rawIcon;
  const next = s.nextFire ? `next: ${s.nextFire.toLocaleString()}` : "paused";
  const task = s.task.length > 24 ? s.task.slice(0, 23) + "…" : s.task;
  const lc = s.lifecycle ?? "default";
  const cwd = s.cwd ? `  ↗${basename(s.cwd)}` : "";
  return `${icon}  ${s.expression}  ${lc}  "${task}"${cwd}  ${next}  ${s.id}`;
}

const LC_GLYPH: Record<LifecycleStatus, string> = {
  running: "▶", checkpoint: "⏸", completed: "✓", failed: "✗", aborted: "✗",
};

export function lifecycleRow(r: LifecycleRunRecord, theme?: RowTheme): string {
  const dur = r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "—";
  const curIdx = r.phases.findIndex((p) => p.status === "running");
  const cur = curIdx >= 0 ? r.phases[curIdx] : r.phases[r.phases.length - 1];
  const curName = cur ? `●${cur.name}` : "—";
  // N/M = current phase position / total (1-indexed); falls back to last phase when none running.
  const counts = `${(curIdx >= 0 ? curIdx + 1 : r.phases.length)}/${r.phases.length}`;
  const glyph = theme ? statusFg(r.status, theme, LC_GLYPH[r.status]) : LC_GLYPH[r.status];
  return `${glyph} ${r.runId}  ${r.lifecycleName}  ${curName} ${counts}  ${r.mode}  ${dur}  ${r.backend}  "${r.task}"`;
}

export function lifecyclePhaseTimeline(r: LifecycleRunRecord): string {
  const lines: string[] = [
    `Lifecycle ${r.runId} — ${r.lifecycleName} — "${r.task}"`,
    `Backend: ${r.backend} · Mode: ${r.mode} · Status: ${r.status}`,
    "",
    "Phases:",
  ];
  for (const p of r.phases) {
    const mark = p.reviseCount > 0 ? "[~]" : p.status === "completed" ? "[x]" : "[ ]";
    const art = p.paths.length ? ` → ${p.paths.join(", ")}` : "";
    lines.push(`  ${mark} ${p.name}  ${p.status}${art}${p.paths.length ? "  [Open]" : ""}`);
    const gateLine = buildGateLine(p.gateResults ?? []);
    if (gateLine) lines.push(`      ${gateLine}`);
  }
  if (r.status === "checkpoint") {
    lines.push("", "── Checkpoint ──", "[Continue]  [Revise]  [Abort]");
  }
  return lines.join("\n");
}
