import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — judge whether results fully satisfy taskArgs via one agent. Returns null if agent can't judge. */
export async function completenessCheck(
  taskArgs: unknown,
  results: unknown,
  ctx: HelperCtx,
  opts: { tier?: string; model?: string; skills?: string[]; backend?: "pi" | "claude"; retries?: number; timeoutMs?: number } = {},
): Promise<{ complete: boolean; missing?: string[] } | null> {
  const prompt = `You are a completeness judge. Given the task args and the results, decide if the results fully satisfy the task.\nTask args: ${JSON.stringify(taskArgs)}\nResults: ${JSON.stringify(results)}\nRespond as JSON: {"complete": boolean, "missing": string[]}`;
  const res = await ctx.spawn(prompt, { agent: "reviewer", ...(opts.tier ? { tier: opts.tier } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.skills ? { skills: opts.skills } : {}), ...(opts.backend ? { backend: opts.backend } : {}), ...(opts.retries ? { retries: opts.retries } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  if (!res || res.status !== "completed") return null;
  try {
    const parsed = JSON.parse(res.finalText) as { complete?: boolean; missing?: string[] };
    if (typeof parsed.complete !== "boolean") return null;
    return { complete: parsed.complete, ...(Array.isArray(parsed.missing) ? { missing: parsed.missing } : {}) };
  } catch { return null; }
}
