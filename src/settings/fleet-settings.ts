// src/settings/fleet-settings.ts
// #78: fleet-dir settings.json — the settings home for fleet-wide defaults that
// aren't env-shaped (sibling of tiers.json in the same global+project scheme).
//
// Locations:
//   global:  ~/.pi/agent/fleet/settings.json
//   project: <cwd>/.pi/fleet/settings.json   (project wins per-field)
//
// Design rules:
// - Absent files are normal (empty settings, no warning).
// - Present-but-invalid content produces ACTIONABLE warnings (file + field + bad
//   value) and drops the field — never a silent swallow (the TierStore ENOENT
//   lesson: silent loaders make wrong docs doubly dangerous).
// - The schema is intentionally small and additive; unknown keys warn so typos
//   surface instead of no-oping.
import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "../registry/frontmatter.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/** Fleet-wide defaults. Intentionally additive — new fields land here. */
export interface FleetSettings {
  /** #78: applied to every subagent whose frontmatter does NOT pin `thinkingLevel`.
   *  Precedence: agent.thinkingLevel > this > the backend/session default. */
  defaultSubagentThinking?: ThinkingLevel;
}

export interface FleetSettingsResult {
  settings: FleetSettings;
  /** Actionable, source-labeled warnings (never empty-string; always name the file). */
  warnings: string[];
}

/** Parse one settings file's content. `label` names the file in warnings. */
export function parseFleetSettings(json: string, label = "settings.json"): FleetSettingsResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { settings: {}, warnings: [`${label}: invalid JSON (${(e as Error).message}) — fleet settings from this file ignored`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: {}, warnings: [`${label}: expected a JSON object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw} — fleet settings from this file ignored`] };
  }
  const obj = raw as Record<string, unknown>;
  const settings: FleetSettings = {};

  const thinking = obj["defaultSubagentThinking"];
  if (thinking !== undefined) {
    if (isThinkingLevel(thinking)) {
      settings.defaultSubagentThinking = thinking;
    } else {
      warnings.push(`${label}: defaultSubagentThinking must be one of ${THINKING_LEVELS.join("|")}, got ${JSON.stringify(thinking)} — ignored`);
    }
  }

  const known = new Set(["defaultSubagentThinking"]);
  const unknownKeys = Object.keys(obj).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    warnings.push(`${label}: unknown setting${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.map((k) => `"${k}"`).join(", ")} — ignored (valid: ${[...known].join(", ")})`);
  }

  return { settings, warnings };
}

export interface FleetSettingsStoreOpts {
  projectPath: string;
  globalPath: string;
}

/** Global+project fleet settings (project wins per-field), mirroring TierStore's scheme. */
export class FleetSettingsStore {
  constructor(private readonly opts: FleetSettingsStoreOpts) {}

  private readOne(path: string, label: string): FleetSettingsResult {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (e) {
      // ENOENT = the normal absent-file state, never a warning. Any OTHER read failure
      // (EACCES, EISDIR, …) on a path that was expected to be readable must surface —
      // silent swallows make misconfiguration invisible (the TierStore lesson).
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { settings: {}, warnings: [] };
      return { settings: {}, warnings: [`${label}: unreadable (${code ?? (e as Error).message}) — fleet settings from this file ignored`] };
    }
    return parseFleetSettings(content, label);
  }

  load(): FleetSettingsResult {
    const global = this.readOne(this.opts.globalPath, this.opts.globalPath);
    const project = this.readOne(this.opts.projectPath, this.opts.projectPath);
    return {
      settings: { ...global.settings, ...project.settings },
      warnings: [...global.warnings, ...project.warnings],
    };
  }
}
