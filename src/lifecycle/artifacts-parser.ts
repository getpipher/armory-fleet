// src/lifecycle/artifacts-parser.ts
import { parse as parseYaml } from "yaml";

export const MAX_REVISE = 3;

export interface ArtifactsOk { summary: string; paths: string[] }
export interface ArtifactsErr { error: string }
export type ArtifactsResult = ArtifactsOk | ArtifactsErr;

/** Parse the trailing `Artifacts:` YAML block from a child's finalText.
 *  Returns {summary, paths} on success, or {error} on failure.
 *  terminal=true exempts a missing block (the finish phase may have no file artifact). */
export function parseArtifacts(finalText: string, opts: { terminal?: boolean } = {}): ArtifactsResult {
  const marker = "Artifacts:";
  const idx = finalText.lastIndexOf(marker);
  if (idx < 0) {
    if (opts.terminal) return { summary: finalText.trim(), paths: [] };
    return { error: "missing Artifacts block (child did not list produced file paths)" };
  }
  const summary = finalText.slice(0, idx).trim();
  const block = finalText.slice(idx + marker.length);
  let parsed: unknown;
  try {
    parsed = parseYaml(block) ?? [];
  } catch (e) {
    return { error: `malformed Artifacts block: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { error: "Artifacts block must be a list of {path, kind}" };
  const entries = parsed as Array<Record<string, unknown>>;
  const paths: string[] = [];
  for (const e of entries) {
    if (typeof e.path === "string" && e.path.trim()) paths.push(e.path.trim());
  }
  if (paths.length === 0 && !opts.terminal) {
    return { error: "Artifacts block has no paths (non-terminal phase must produce at least one file)" };
  }
  return { summary, paths };
}