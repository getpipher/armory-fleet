// SPEC-6-3 §3.1 — canonical workflow source parser. Extracts `export const meta = {…}`
// via a balanced-brace scanner (the old non-greedy regex broke on nested braces / multi-line),
// retains the editable sourceText + stripped body, and normalizes an executable string
// that the vm realm can compile as CommonJS.

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: { title: string }[];
}

export interface ParsedWorkflowSource {
  meta?: WorkflowMeta;
  source: string;
  body: string;
  executable: string;
}

const META_MARKER = "export const meta =";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

const WINDOWS_RESERVED = new Set<string>([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Validate a workflow save name. Must be kebab-case (`^[a-z][a-z0-9-]{0,63}$`).
 * Rejects Windows device names (con, prn, aux, nul, com1–9, lpt1–9) and any path traversal.
 */
export function validateWorkflowName(name: string): void {
  if (!NAME_RE.test(name) || WINDOWS_RESERVED.has(name.toLowerCase())) {
    throw new Error(`invalid workflow name: '${name}'`);
  }
}

/**
 * Scan a balanced `{…}` object starting at `start` (which must point at the opening brace).
 * Ignores braces inside single/double/backtick quoted strings. Returns the raw text including
 * the outer braces, or `null` if unbalanced.
 */
function extractBalancedBraces(source: string, start: number): string | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;

    if (inSingle) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\") { i++; continue; }
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "`") { inBacktick = true; continue; }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Parse a workflow source file into its meta, body, and executable form.
 *
 * - Extracts `export const meta = {…}` via balanced-brace scanning (ignoring braces in
 *   quoted strings). Evaluates the extracted object under the existing trusted-dev posture.
 * - `body` is the source after the meta declaration is removed (trimmed).
 * - `executable` wraps the body as `module.exports = (async () => { … })()` unless the body
 *   already starts with `module.exports =` (legacy CommonJS).
 *
 * When `requireMeta` is true and no meta declaration is found, throws.
 */
export function parseWorkflowSource(
  source: string,
  opts: { filePath: string; requireMeta: boolean },
): ParsedWorkflowSource {
  const metaStart = source.indexOf(META_MARKER);

  if (metaStart === -1) {
    if (opts.requireMeta) {
      throw new Error(`${opts.filePath}: missing \`export const meta = {…}\``);
    }
    const body = source.trim();
    const executable = /^\s*module\.exports\s*=/.test(body)
      ? body
      : `module.exports = (async () => {\n${body}\n})()`;
    return { source, body, executable };
  }

  // Skip whitespace to find the opening brace
  let braceStart = metaStart + META_MARKER.length;
  while (braceStart < source.length && source[braceStart] !== "{") braceStart++;
  if (braceStart >= source.length) {
    throw new Error(`${opts.filePath}: meta declaration has no opening brace`);
  }

  const metaText = extractBalancedBraces(source, braceStart);
  if (metaText === null) {
    throw new Error(`${opts.filePath}: meta declaration has unbalanced braces`);
  }

  // Evaluate the extracted object (trusted-dev-environment; meta is small + author-controlled)
  let meta: WorkflowMeta;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${metaText})`);
    const raw = fn() as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name.trim()) {
      throw new Error(`${opts.filePath}: meta.name missing`);
    }
    if (typeof raw.description !== "string") {
      throw new Error(`${opts.filePath}: meta.description missing`);
    }
    const phases = Array.isArray(raw.phases) ? raw.phases as { title: string }[] : [];
    meta = {
      name: raw.name.trim(),
      description: raw.description.trim(),
      phases,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith(opts.filePath)) throw e;
    throw new Error(`${opts.filePath}: meta parse failed: ${msg}`);
  }

  // Body is everything after the complete meta declaration
  const declEnd = braceStart + metaText.length;
  const body = source.slice(declEnd).trim();

  const executable = /^\s*module\.exports\s*=/.test(body)
    ? body
    : `module.exports = (async () => {\n${body}\n})()`;

  return { meta, source, body, executable };
}
