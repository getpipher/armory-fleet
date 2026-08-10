// src/memory-hydrate/port.ts — fleet-owned port; fleet core depends only on this.
export interface MemoryScopes {
  /** The cwd the child works in (= parentCwd in SPEC-2; the project cwd at SPEC-5a worktree). */
  project: string;
  /** Immediate parent directory of the project cwd (workspace/org level). */
  local: string;
  /** Optional — only present when the agent opted in via `userMemory: true` (SPEC-6-5).
   *  The user scope is a cross-project memory bleed by construction; omitted unless explicitly enabled. */
  user?: string;
}
export interface MemoryHydratePort {
  /** Render the three-scope memory block (project → local → user), concatenated. Empty string when all scopes empty. */
  renderScopes(scopes: MemoryScopes): string;
}