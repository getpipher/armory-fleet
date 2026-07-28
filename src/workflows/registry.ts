// SPEC-6-3 §3.7 — saved-workflow discovery. Project > global > builtin (later scopes win by name).
// A workflow .js exports `meta` { name, description, phases? } + a script body. We parse the
// meta via a lightweight regex + new Function() eval (trusted-dev-environment; meta is small
// + author-controlled). The full file body is passed through to the runner as `script`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type WorkflowSource = "builtin" | "global" | "project";

export interface WorkflowDef {
  name: string;
  description: string;
  phases: { title: string }[];
  script: string;     // the full file body (the runner compiles + runs it)
  source: WorkflowSource;
  filePath: string;
}

export interface DiscoverOpts { projectDir: string; globalDir: string; builtinDir: string; }

export interface DiscoverResult {
  workflows: Map<string, WorkflowDef>;
  errors: string[];
  warnings: string[];
}

const META_RE = /export\s+const\s+meta\s*=\s*({[\s\S]*?})\s*$/m;

function parseMeta(content: string, filePath: string): { name: string; description: string; phases: { title: string }[] } | { error: string } {
  const m = META_RE.exec(content);
  if (!m || m[1] === undefined) return { error: `${filePath}: missing \`export const meta = {…}\`` };
  // Lightweight eval of the meta object (trusted-dev-environment; meta is small + author-controlled)
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${m[1]})`);
    const meta = fn() as { name?: string; description?: string; phases?: { title: string }[] };
    if (typeof meta.name !== "string" || !meta.name.trim()) return { error: `${filePath}: meta.name missing` };
    if (typeof meta.description !== "string") return { error: `${filePath}: meta.description missing` };
    return { name: meta.name.trim(), description: meta.description.trim(), phases: Array.isArray(meta.phases) ? meta.phases : [] };
  } catch (e) { return { error: `${filePath}: meta parse failed: ${(e as Error).message}` }; }
}

function loadDir(dir: string, source: WorkflowSource, into: Map<string, WorkflowDef>, errors: string[]): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const filePath = join(dir, f);
    const content = readFileSync(filePath, "utf8");
    const parsed = parseMeta(content, filePath);
    if ("error" in parsed) { errors.push(parsed.error); continue; }
    const name = parsed.name;
    into.set(name, { name, description: parsed.description, phases: parsed.phases, script: content, source, filePath });
  }
}

/** Discover workflows from three scopes. Later scopes win by name (project > global > builtin). */
export function discoverWorkflows(opts: DiscoverOpts): DiscoverResult {
  const map = new Map<string, WorkflowDef>();
  const errors: string[] = [];
  loadDir(opts.builtinDir, "builtin", map, errors);
  loadDir(opts.globalDir, "global", map, errors);
  loadDir(opts.projectDir, "project", map, errors); // project shadows (set last wins)
  return { workflows: map, errors, warnings: [] };
}

export class WorkflowRegistry {
  private readonly byName = new Map<string, WorkflowDef>();
  constructor(workflows: Map<string, WorkflowDef>) { for (const [k, v] of workflows) this.byName.set(k, v); }
  get(name: string): WorkflowDef | undefined { return this.byName.get(name); }
  list(): WorkflowDef[] { return [...this.byName.values()]; }
}
