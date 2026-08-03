import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — script-level human gate. Standalone (NOT CheckpointFn reuse).
 *  Interactive: resolves via ctx.onCheckpoint. Headless: returns opts.default (or aborts). */
export async function checkpoint(
  prompt: string,
  opts: { kind?: "confirm" | "input" | "select"; choices?: string[]; default?: unknown; headless?: "default" | "abort"; timeoutMs?: number } = {},
  ctx: HelperCtx,
): Promise<unknown> {
  // Interactive bridge present → use it (the Workflows view resolves the pending checkpoint).
  if (ctx.onCheckpoint) return ctx.onCheckpoint(prompt, opts as Record<string, unknown>);
  const headless = opts.headless ?? "default";
  if (headless === "abort") throw new Error("checkpoint abort: headless mode with no UI");
  return opts.default ?? true;
}
