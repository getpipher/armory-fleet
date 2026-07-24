// src/memory-hydrate/port.ts — fleet-owned port; fleet core depends only on this.
export interface MemoryScopes {
  /** The cwd the child works in (= parentCwd in SPEC-2; the project cwd at SPEC-5a worktree). */
  project: string;
  /** Immediate parent directory of the project cwd (workspace/org level). */
  local: string;
  /** Fixed pseudo-cwd for global cross-project user memory. */
  user: string;
}
export interface MemoryHydratePort {
  /** Render the three-scope memory block (project → local → user), concatenated. Empty string when all scopes empty. */
  renderScopes(scopes: MemoryScopes): string;
}