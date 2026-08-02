// SPEC-6-3 §3.7 — saved-workflow discovery. Project > global > builtin (later scopes win by name).
// A workflow .js exports `meta` { name, description, phases? } + a script body. We parse the
// source via the canonical balanced-brace parser (source.ts) which produces the meta, the
// stripped body, and a normalized `executable` string the vm realm can compile as CommonJS.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowSource } from "./source.ts";

export type WorkflowSource = "builtin" | "global" | "project";

export interface WorkflowDef {
  name: string;
  description: string;
  phases: { title: string }[];
  sourceText: string;   // the original file content
  body: string;         // script body after the meta declaration is removed
  executable: string;    // normalized CommonJS executable (passed to the runner)
  source: WorkflowSource;
  filePath: string;
}

export interface DiscoverOpts { projectDir: string; globalDir: string; builtinDir: string; }

export interface DiscoverResult {
  workflows: Map<string, WorkflowDef>;
  errors: string[];
  warnings: string[];
}

function loadDir(dir: string, source: WorkflowSource, into: Map<string, WorkflowDef>, errors: string[]): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const filePath = join(dir, f);
    const content = readFileSync(filePath, "utf8");
    try {
      const parsed = parseWorkflowSource(content, { filePath, requireMeta: true });
      if (!parsed.meta) { errors.push(`${filePath}: missing \`export const meta = {…}\``); continue; }
      const { name, description, phases } = parsed.meta;
      into.set(name, { name, description, phases, sourceText: parsed.source, body: parsed.body, executable: parsed.executable, source, filePath });
    } catch (e) {
      errors.push((e as Error).message);
    }
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
