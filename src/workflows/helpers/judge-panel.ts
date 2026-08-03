import type { HelperCtx } from "./types.ts";

interface Judgment { score: number; reason?: string }
interface PanelResult { index: number; attempt: unknown; score: number; judgments: Judgment[] }

/** SPEC-6-3 §3.3 — N judges score every attempt; highest average score wins. Closes 6-2.1. */
export async function judgePanel(
  attempts: unknown[],
  opts: { judges?: number; rubric?: string; tier?: string; model?: string; skills?: string[]; backend?: "pi" | "claude"; retries?: number; timeoutMs?: number } = {},
  ctx: HelperCtx,
): Promise<PanelResult | undefined> {
  if (attempts.length === 0) return undefined;
  const judges = opts.judges ?? 3;
  const rubric = opts.rubric ?? "overall quality and correctness";
  const perAttempt: Judgment[][] = attempts.map(() => []);
  for (let j = 0; j < judges; j++) {
    for (let a = 0; a < attempts.length; a++) {
      const prompt = `You are judge ${j + 1} of ${judges}. Score this attempt on a 0-10 scale.\nRubric: ${rubric}\nAttempt ${a}: ${JSON.stringify(attempts[a])}\nRespond as JSON: {"score": number, "reason": string}`;
      const res = await ctx.spawn(prompt, { agent: "reviewer", ...(opts.tier ? { tier: opts.tier } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.skills ? { skills: opts.skills } : {}), ...(opts.backend ? { backend: opts.backend } : {}), ...(opts.retries ? { retries: opts.retries } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
      if (res && res.status === "completed") {
        try { const p = JSON.parse(res.finalText) as { score?: number; reason?: string }; perAttempt[a]!.push({ score: typeof p.score === "number" ? p.score : 0, ...(p.reason ? { reason: p.reason } : {}) }); }
        catch { perAttempt[a]!.push({ score: 0 }); }
      } else { perAttempt[a]!.push({ score: 0 }); }
    }
  }
  let best: PanelResult | undefined;
  for (let a = 0; a < attempts.length; a++) {
    const js = perAttempt[a]!;
    const score = js.reduce((s, x) => s + x.score, 0) / (js.length || 1);
    if (!best || score > best.score) best = { index: a, attempt: attempts[a], score, judgments: js };
  }
  return best;
}
