import type { HelperCtx } from "./types.ts";

const REAL_RE = /\b(real|valid|correct|true|confirmed|legit)\b/i;

function judgeVote(text: string): { real: boolean; reason?: string } {
  return { real: REAL_RE.test(text), reason: text.slice(0, 200) };
}

/** SPEC-6-3 §3.3 — N reviewers vote; real = realCount/total >= threshold (default 0.5). */
export async function verify(
  item: unknown,
  opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ctx: HelperCtx,
): Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }> {
  const reviewers = opts.reviewers ?? 2;
  const threshold = opts.threshold ?? 0.5;
  const lens = opts.lens ? ` Focus lens: ${Array.isArray(opts.lens) ? opts.lens.join(", ") : opts.lens}.` : "";
  const prompt = `You are an independent reviewer. Decide if the following item is REAL/valid.\nItem: ${JSON.stringify(item)}${lens}\nRespond with "real" or "fake" + a one-line reason.`;
  const votes: Array<{ real: boolean; reason?: string }> = [];
  for (let i = 0; i < reviewers; i++) {
    const res = await ctx.spawn(prompt, { agent: "reviewer" });
    if (!res || res.status !== "completed") { votes.push({ real: false, reason: "reviewer failed" }); continue; }
    votes.push(judgeVote(res.finalText));
  }
  const realCount = votes.filter((v) => v.real).length;
  return { real: realCount / reviewers >= threshold, realCount, total: reviewers, votes };
}
