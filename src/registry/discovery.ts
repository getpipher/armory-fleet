// src/registry/discovery.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentFile, type AgentDef, FrontmatterError } from "./frontmatter.ts";

export interface DiscoverOpts {
  projectDir: string | null;
  globalDir: string | null;
  builtinDir: string | null;
}

export interface DiscoverResult {
  agents: Map<string, AgentDef>;
  warnings: string[];
  errors: string[];
}

/** Recursively collect *.md file paths under dir. */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Load order: builtin -> global -> project (later wins on name; same-scope dup = error). */
export function discoverAgents(opts: DiscoverOpts): DiscoverResult {
  const agents = new Map<string, AgentDef>();
  const warnings: string[] = [];
  const errors: string[] = [];

  const loadScope = (dir: string | null, source: AgentDef["source"]): void => {
    if (!dir) return;
    const files = collectMarkdown(dir).sort(); // stable order for collision reporting
    for (const f of files) {
      let content: string;
      try {
        content = readFileSync(f, "utf8");
      } catch {
        warnings.push(`${f}: unreadable file, skipped`);
        continue;
      }
      try {
        const def = parseAgentFile(content, f, source);
        const existing = agents.get(def.name);
        if (existing && existing.source === source) {
          errors.push(`duplicate agent '${def.name}' in ${source} scope (${f}); first kept`);
          continue;
        }
        // cross-scope override (project over global/builtin) is fine
        agents.set(def.name, def);
      } catch (e) {
        if (e instanceof FrontmatterError) warnings.push(e.message);
        else warnings.push(`${f}: ${String(e)}`);
      }
    }
  };

  loadScope(opts.builtinDir, "builtin");
  loadScope(opts.globalDir, "global");
  loadScope(opts.projectDir, "project"); // project overrides
  return { agents, warnings, errors };
}