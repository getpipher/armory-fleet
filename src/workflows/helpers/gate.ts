import type { HelperCtx } from "./types.ts";

/** SPEC-6-3 §3.3 — run thunk, validate; on fail re-run with feedback up to `attempts`. */
export async function gate(
  thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>,
  validator: (value: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>,
  opts: { attempts?: number } = {},
  ctx: HelperCtx,
): Promise<{ ok: boolean; value: unknown; attempts: number }> {
  const attempts = opts.attempts ?? 3;
  let feedback: string | undefined;
  let lastValue: unknown;
  for (let n = 0; n < attempts; n++) {
    const value = await thunk(feedback, n);
    lastValue = value;
    const verdict = await validator(value);
    if (verdict.ok) return { ok: true, value, attempts: n + 1 };
    feedback = verdict.feedback;
  }
  // exhausted: return the last value from within the attempts budget (no extra run).
  return { ok: false, value: lastValue, attempts };
}
