import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — judge whether results fully satisfy taskArgs via one agent. Returns null if agent can't judge. */
export async function completenessCheck(
  taskArgs: unknown,
  results: unknown,
  ctx: HelperCtx,
): Promise<{ complete: boolean; missing?: string[] } | null> {
  const prompt = `You are a completeness judge. Given the task args and the results, decide if the results fully satisfy the task.\nTask args: ${JSON.stringify(taskArgs)}\nResults: ${JSON.stringify(results)}\nRespond as JSON: {"complete": boolean, "missing": string[]}`;
  const res = await ctx.spawn(prompt, { agent: "reviewer" });
  if (!res || res.status !== "completed") return null;
  try {
    const parsed = JSON.parse(res.finalText) as { complete?: boolean; missing?: string[] };
    if (typeof parsed.complete !== "boolean") return null;
    return { complete: parsed.complete, ...(Array.isArray(parsed.missing) ? { missing: parsed.missing } : {}) };
  } catch { return null; }
}
