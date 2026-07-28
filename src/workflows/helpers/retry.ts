import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — retry a thunk up to `attempts`; `until` decides when to stop. */
export async function retry(
  thunk: (attempt: number) => unknown | Promise<unknown>,
  opts: { attempts?: number; until?: (result: unknown) => boolean } = {},
  ctx: HelperCtx,
): Promise<unknown> {
  const attempts = opts.attempts ?? 3;
  const until = opts.until ?? (() => true);
  let last: unknown;
  for (let n = 0; n < attempts; n++) {
    try { last = await thunk(n); } catch { continue; } // recoverable: try again
    if (until(last)) return last;
  }
  return last;
}
