import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — discovery loop: call round(n) → items; de-dupe by key; stop after consecutiveEmpty empty rounds or maxRounds. */
export async function loopUntilDry(
  opts: { round: (roundIndex: number) => unknown[] | Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number },
  ctx: HelperCtx,
): Promise<unknown[]> {
  const consecutiveEmpty = opts.consecutiveEmpty ?? 2;
  const maxRounds = opts.maxRounds ?? 50;
  const key = opts.key ?? ((item: unknown) => JSON.stringify(item));
  const seen = new Set<string>();
  const acc: unknown[] = [];
  let emptyStreak = 0;
  for (let n = 0; n < maxRounds; n++) {
    const items = await opts.round(n);
    const fresh = (Array.isArray(items) ? items : []).filter((it) => { const k = key(it); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const f of fresh) acc.push(f);
    if (fresh.length === 0) { emptyStreak++; if (emptyStreak >= consecutiveEmpty) break; } else emptyStreak = 0;
  }
  return acc;
}
