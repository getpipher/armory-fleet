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
  // Strip a trailing prompt-echo trailer (e.g. CIPHER's "📌 YOUR PROMPT: ..." bordered by `---`),
  // which the child may inherit from the base system prompt. The echo can contain the literal
  // "Artifacts:" (quoting the phase instruction) and would fool lastIndexOf below.
  let text = finalText;
  const echoIdx = text.lastIndexOf("📌 YOUR PROMPT:");
  if (echoIdx >= 0) {
    text = text.slice(0, echoIdx).replace(/\n---\s*$/, "");
  }
  const marker = "Artifacts:";
  const idx = text.lastIndexOf(marker);
  if (idx < 0) {
    if (opts.terminal) return { summary: text.trim(), paths: [] };
    return { error: "missing Artifacts block (child did not list produced file paths)" };
  }
  const summary = text.slice(0, idx).trim();
  let block = text.slice(idx + marker.length);
  // Robustness: models often wrap the YAML in a fenced code block (the `Artifacts:` marker sits
  // inside the fence) and/or trail a prompt-echo / signature. Strip a leading opening fence line
  // (```yaml) if present, then truncate at the FIRST closing fence (```) or markdown thematic
  // break (`\n---\n`) — whichever comes first — so trailing content can't break the YAML parse.
  block = block.replace(/^\s*```[a-zA-Z]*\s*\n/, "");
  const fenceClose = block.indexOf("```");
  const brk = block.search(/\n---\s*\n/);
  let cut = block.length;
  if (fenceClose >= 0) cut = Math.min(cut, fenceClose);
  if (brk >= 0) cut = Math.min(cut, brk);
  block = block.slice(0, cut);
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