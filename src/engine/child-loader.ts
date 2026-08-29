// src/engine/child-loader.ts — the fleet CustomResourceLoader builder.
// Promotes SPEC-1's DefaultResourceLoader-with-overrides to deliberate control:
// noExtensions (deterministic child, no host-extension leakage), composed
// systemPromptOverride (rolePrompt + memoryBlock + base), scoped skills.
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync as fsExistsSync } from "node:fs";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";

/** Shape of the pi resource-loader's current-skills context (the `cur` arg of skillsOverride).
 *  Generic over the skill + diagnostics types so the pi SDK's full `Skill`/`ResourceDiagnostic`
 *  types flow through unchanged. */
export interface InstalledSkills<S = { name: string }, D = unknown> {
  skills: S[];
  diagnostics: D;
}

/** #32: resolve the child's skill bundle from the agent's declared skills + the installed arsenal.
 *
 *  - Agent declares specific skills → load only those (filtered from the installed arsenal).
 *  - Agent declares NO skills → load NO skills (lean substrate). This is the #32 fix: previously
 *    an agent with no `skills` field loaded ALL installed skills (~42 → ~570K substrate on every
 *    `general-purpose` dispatch, ~59% of a 976K context window from turn 1). Callers opt in to
 *    skills via the `subagent` tool's `skills` param (threaded as `skillsOverride`, which clones
 *    `agent.skills` before this runs).
 *  - Returning `[]` (not `cur.skills`) is the deliberate behavior change. */
export function resolveChildSkills<S extends { name: string }, D>(agent: Pick<AgentDef, "skills">, cur: InstalledSkills<S, D>): InstalledSkills<S, D> {
  const selected = agent.skills && agent.skills.length
    ? cur.skills.filter((s) => agent.skills!.includes(s.name))
    : [];
  return { skills: selected, diagnostics: cur.diagnostics };
}

/** Fixed pseudo-cwd for the global cross-project user memory scope. */
export const USER_PSEUDO_CWD = "/__armory-fleet-user__";

/** Compose the child system prompt: rolePrompt → memoryBlock → base (empty memoryBlock omitted). */
export function composeChildPrompt(args: { rolePrompt: string; memoryBlock: string; base: string }): string {
  return [args.rolePrompt, args.memoryBlock, args.base].filter((s) => s && s.trim().length > 0).join("\n\n");
}

/** Build the memory scopes for a child: project=cwd, local=parent dir; user only when opted in.
 *  #20/SPEC-6-5: the user pseudo-scope (`/__armory-fleet-user__`) is a cross-project bleed by
 *  construction — omit it unless the agent declares `userMemory: true`. */
export function memoryScopesFor(cwd: string, opts?: { includeUser?: boolean }): { project: string; local: string; user?: string } {
  return { project: cwd, local: dirname(cwd) || cwd, ...(opts?.includeUser ? { user: USER_PSEUDO_CWD } : {}) };
}

/** #40: resolve extra skill dirs to scan for the child, beyond the default `~/.pi/agent/skills`.
 *
 *  The parent's pi package-manager scans `~/.agents/skills` (user) + `<cwd>/.agents/skills`
 *  (project) and feeds them to the loader via `extendResources` — that's how cross-harness skills
 *  like firecrawl (which live in `~/.agents/skills`, NOT `~/.pi/agent/skills`) reach the parent.
 *  The child's bare `DefaultResourceLoader` skips that, so a `skills: ["firecrawl-scrape"]` opt-in
 *  can't resolve. We restore the parent's skill surface by passing these dirs as `additionalSkillPaths`.
 *
 *  Returns absolute paths only for dirs that exist (no hard dependency on the `~/.agents` layout —
 *  machines without it get []). Inject `homedir`/`cwd`/`existsSync` for testability. */
export function resolveAdditionalSkillPaths(opts: { homedir?: string; cwd: string; existsSync?: (p: string) => boolean }): string[] {
  const home = opts.homedir ?? homedir();
  const exists = opts.existsSync ?? ((p: string) => { try { return fsExistsSync(p); } catch { return false; } });
  const candidates = [join(home, ".agents", "skills"), join(opts.cwd, ".agents", "skills")];
  const out: string[] = [];
  for (const p of candidates) if (!out.includes(p) && exists(p)) out.push(p);
  return out;
}

export interface ChildLoaderOpts {
  cwd: string;
  agent: AgentDef;
  memoryPort: MemoryHydratePort;
}

/** Build the fleet CustomResourceLoader for a child session. */
export function buildChildLoader(opts: ChildLoaderOpts): DefaultResourceLoader {
  const scopes = memoryScopesFor(opts.cwd, { includeUser: opts.agent.userMemory ?? false });
  const memoryBlock = opts.agent.memoryHydrate ? opts.memoryPort.renderScopes(scopes) : "";
  return new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    // #40: scan the shared `~/.agents/skills` + `<cwd>/.agents/skills` dirs so cross-harness skills
    //  (firecrawl, etc.) are discoverable by a caller's `skills` opt-in, matching the parent surface.
    additionalSkillPaths: resolveAdditionalSkillPaths({ cwd: opts.cwd }),
    systemPromptOverride: (base) =>
      composeChildPrompt({ rolePrompt: opts.agent.rolePrompt, memoryBlock, base: base ?? "" }),
    skillsOverride: (cur) => resolveChildSkills(opts.agent, cur),
  });
}
