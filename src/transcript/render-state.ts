// src/transcript/render-state.ts — pure timer-decision helper for the #104 render slots.
// No timers live here: the render slots execute the decisions (setInterval/clearInterval);
// this module only decides, so the state machine is unit-testable without a TUI.
import type { RunCardState } from "./card-state.ts";

/** Shared per-tool-row renderer state (ToolRenderContext.state), per the plan's Task 5 shape. */
export interface RenderSlotState {
  frame: number;
  timer: NodeJS.Timeout | null;
  lastCard: RunCardState | null;
}

export interface RenderDecision {
  startTimer: boolean;
  stopTimer: boolean;
}

/** Decide the timer transition for one render-slot invocation.
 *  - final render (`isPartial: false`): ALWAYS stop — no timer may survive finalize.
 *  - partial with a card: events drive updates now — stop the animation timer.
 *  - partial without a card yet: still dispatching — start the spinner timer (once). */
export function nextRenderState(st: RenderSlotState, ev: { hasCard: boolean; isPartial: boolean }): RenderDecision {
  if (!ev.isPartial) return { startTimer: false, stopTimer: st.timer != null };
  if (ev.hasCard) return { startTimer: false, stopTimer: st.timer != null };
  return { startTimer: st.timer == null, stopTimer: false };
}
