// src/backend/port.ts — single import surface for engine + views (SPEC-3 §3).
export type { BackendHookParity, HookState } from "./hook-parity.ts";
export { PI_HOOK_PARITY, CLAUDE_HOOK_PARITY } from "./hook-parity.ts";
export type { Backend, BackendVersionInfo } from "./registry.ts";
export { BackendRegistry } from "./registry.ts";