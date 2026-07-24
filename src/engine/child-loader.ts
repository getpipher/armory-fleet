// src/engine/child-loader.ts — the fleet CustomResourceLoader builder.
// Promotes SPEC-1's DefaultResourceLoader-with-overrides to deliberate control:
// noExtensions (deterministic child, no host-extension leakage), composed
// systemPromptOverride (rolePrompt + memoryBlock + base), scoped skills.
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";

/** Fixed pseudo-cwd for the global cross-project user memory scope. */
export const USER_PSEUDO_CWD = "/__armory-fleet-user__";

/** Compose the child system prompt: rolePrompt → memoryBlock → base (empty memoryBlock omitted). */
export function composeChildPrompt(args: { rolePrompt: string; memoryBlock: string; base: string }): string {
  return [args.rolePrompt, args.memoryBlock, args.base].filter((s) => s && s.trim().length > 0).join("\n\n");
}

/** Build the three memory scopes for a child: project=cwd, local=parent dir, user=sentinel. */
export function memoryScopesFor(cwd: string): { project: string; local: string; user: string } {
  return { project: cwd, local: dirname(cwd) || cwd, user: USER_PSEUDO_CWD };
}

export interface ChildLoaderOpts {
  cwd: string;
  agent: AgentDef;
  memoryPort: MemoryHydratePort;
}

/** Build the fleet CustomResourceLoader for a child session. */
export function buildChildLoader(opts: ChildLoaderOpts): DefaultResourceLoader {
  const scopes = memoryScopesFor(opts.cwd);
  const memoryBlock = opts.agent.memoryHydrate ? opts.memoryPort.renderScopes(scopes) : "";
  return new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    systemPromptOverride: (base) =>
      composeChildPrompt({ rolePrompt: opts.agent.rolePrompt, memoryBlock, base: base ?? "" }),
    skillsOverride: (cur) => ({
      skills:
        opts.agent.skills && opts.agent.skills.length
          ? cur.skills.filter((s) => opts.agent.skills!.includes(s.name))
          : cur.skills,
      diagnostics: cur.diagnostics,
    }),
  });
}