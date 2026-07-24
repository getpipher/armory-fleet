// src/engine/turn-budget.ts
export const DEFAULT_MAX_TURNS = 20;

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