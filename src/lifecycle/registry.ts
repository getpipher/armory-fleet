// src/lifecycle/registry.ts
import { parse as parseYaml } from "yaml";
import { basename, extname } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentSource } from "../registry/frontmatter.ts";
import type { BackendId, LifecycleDef, PhaseDef } from "./lifecycle-types.ts";

export class LifecycleParseError extends Error {
  override name = "LifecycleParseError" as const;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const VALID_BACKENDS: BackendId[] = ["pi", "claude"];

/** Parse a lifecycle markdown file into a LifecycleDef. Throws LifecycleParseError on any malformed input. */
export function parseLifecycleFile(content: string, filePath: string, source: AgentSource): LifecycleDef {
  const m = FM_RE.exec(content);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new LifecycleParseError(`${filePath}: missing --- frontmatter delimiters`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new LifecycleParseError(`${filePath}: invalid YAML (${(e as Error).message})`);
  }
  const body = m[2];

  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : basename(filePath, extname(filePath));
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) throw new LifecycleParseError(`${filePath}: description is required`);

  const rawBackend = typeof raw.backend === "string" ? raw.backend.trim() : "pi";
  if (!VALID_BACKENDS.includes(rawBackend as BackendId)) {
    throw new LifecycleParseError(`${filePath}: invalid backend '${rawBackend}' (must be 'pi' | 'claude')`);
  }
  const backend = rawBackend as BackendId;

  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    throw new LifecycleParseError(`${filePath}: phases must be a non-empty array`);
  }

  // Parse phase frontmatter entries (name + skills + agent + backend + checkpoint); templates resolved after.
  const phaseNames = new Set<string>();
  const partialPhases = raw.phases.map((p: unknown, i: number) => {
    if (!p || typeof p !== "object") {
      throw new LifecycleParseError(`${filePath}: phases[${i}] must be an object`);
    }
    const po = p as Record<string, unknown>;
    const pname = typeof po.name === "string" && po.name.trim() ? po.name.trim() : "";
    if (!pname) throw new LifecycleParseError(`${filePath}: phases[${i}].name is required`);
    if (phaseNames.has(pname)) {
      throw new LifecycleParseError(`${filePath}: duplicate phase '${pname}'`);
    }
    phaseNames.add(pname);
    if (!Array.isArray(po.skills)) {
      throw new LifecycleParseError(`${filePath}: phase '${pname}' skills must be an array`);
    }
    const skills = po.skills.map((s) => String(s));
    const agent = typeof po.agent === "string" && po.agent.trim() ? po.agent.trim() : undefined;
    let pbackend: BackendId | undefined;
    if (po.backend !== undefined) {
      const b = String(po.backend).trim();
      if (!VALID_BACKENDS.includes(b as BackendId)) {
        throw new LifecycleParseError(`${filePath}: phase '${pname}' invalid backend '${b}'`);
      }
      pbackend = b as BackendId;
    }
    const checkpoint = po.checkpoint === undefined ? true : Boolean(po.checkpoint);
    return { name: pname, skills, agent, backend: pbackend, checkpoint };
  });

  // Split body into `## <phase>` sections. A phase with no matching section = error.
  const templates = splitPhaseTemplates(body, filePath);
  const phases: PhaseDef[] = partialPhases.map((p) => {
    const promptTemplate = templates.get(p.name);
    if (promptTemplate === undefined) {
      throw new LifecycleParseError(`${filePath}: phase '${p.name}' missing template (no '## ${p.name}' body section)`);
    }
    return { ...p, promptTemplate };
  });
  // The terminal phase never checkpoints after it (the lifecycle is done) — §5.4.
  if (phases.length > 0) phases[phases.length - 1]!.checkpoint = false;

  return { name, description, backend, phases, source, filePath };
}

/** Split the markdown body into a map of phase-name → prompt-template, by `## <name>` H2 headings. */
function splitPhaseTemplates(body: string, filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  const H2 = /^##\s+(\S[^\r\n]*)$/;
  for (const line of lines) {
    const h = H2.exec(line);
    if (h && h[1] !== undefined) {
      current = h[1].trim();
      if (current !== null && out.has(current)) {
        throw new LifecycleParseError(`${filePath}: duplicate '## ${current}' body section`);
      }
      if (current !== null) out.set(current, "");
    } else if (current !== null) {
      out.set(current, (out.get(current) ?? "") + line + "\n");
    }
  }
  return out;
}
export interface LifecycleDiscoverOpts {
  projectDir: string | null;
  globalDir: string | null;
  builtinDir: string | null;
}

export interface LifecycleDiscoverResult {
  lifecycles: Map<string, LifecycleDef>;
  warnings: string[];
  errors: string[];
}

/** Recursively collect *.md file paths (mirror registry/discovery.ts). */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    let real: string;
    try { real = realpathSync(d); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function discoverLifecycles(opts: LifecycleDiscoverOpts): LifecycleDiscoverResult {
  const lifecycles = new Map<string, LifecycleDef>();
  const warnings: string[] = [];
  const errors: string[] = [];
  const loadScope = (dir: string | null, source: AgentSource): void => {
    if (!dir) return;
    for (const f of collectMarkdown(dir).sort()) {
      let content: string;
      try { content = readFileSync(f, "utf8"); } catch { warnings.push(`${f}: unreadable file, skipped`); continue; }
      try {
        const def = parseLifecycleFile(content, f, source);
        const existing = lifecycles.get(def.name);
        if (existing && existing.source === source) {
          errors.push(`duplicate lifecycle '${def.name}' in ${source} scope (${f}); first kept`);
          continue;
        }
        lifecycles.set(def.name, def); // project over global/builtin (later wins)
      } catch (e) {
        warnings.push(e instanceof LifecycleParseError ? e.message : `${f}: ${String(e)}`);
      }
    }
  };
  loadScope(opts.builtinDir, "builtin");
  loadScope(opts.globalDir, "global");
  loadScope(opts.projectDir, "project");
  return { lifecycles, warnings, errors };
}
