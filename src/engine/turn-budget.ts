// src/engine/turn-budget.ts
/** Default per-run turn budget. Effectively uncapped for normal work — a very complex
 *  multi-file task rarely exceeds ~100 turns; 1000 bounds runaway loops while never clipping
 *  legit work. Callers may pass a tighter `maxTurns` (e.g. 5) for trivial lookups. (v0.9.4: was 20.) */
export const DEFAULT_MAX_TURNS = 1000;

export interface TurnBudget {
  /** Returns true when the just-consumed turn meets/exceeds the cap. */
  consume(): boolean;
  count(): number;
}

export function createTurnBudget(max: number = DEFAULT_MAX_TURNS): TurnBudget {
  let n = 0;
  return {
    consume(): boolean {
      n += 1;
      return n >= max;
    },
    count(): number {
      return n;
    },
  };
}