// src/backend/hook-parity.ts — declared per-backend hook parity (SPEC-3 §2.3, §4.6).
// The chip is a static backend property, never inferred at spawn time.

export type HookState = "✓" | "~";

export interface BackendHookParity {
  /** `todo` tool excluded from the child. */
  todo: HookState;
  /** memory-hydrate (3-scope) active in the child. */
  memory: HookState;
  /** vision: capability-aware. `✓` = full (describe_image fallback); `~` = pass-through only. */
  vision: HookState;
}

/** Pi backend: full moat via loader injection + customTools (SPEC-2). */
export const PI_HOOK_PARITY: BackendHookParity = { todo: "✓", memory: "✓", vision: "✓" };

/** CC backend: moat via prompt/flag translation. Vision has no describe_image fallback (`~`). */
export const CLAUDE_HOOK_PARITY: BackendHookParity = { todo: "✓", memory: "✓", vision: "~" };