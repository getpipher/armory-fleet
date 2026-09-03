// src/transcript/orchestration.ts — pure waiting-on tree + TODO projection + gate line (#104).
// No I/O; `now` is a parameter (replay-safe). The entry renderer owns caching + the frame clock.
import { GLYPHS, spinnerFrame } from "../present/glyphs.ts";
import { excerpt } from "../present/width.ts";
import type { RunCardState } from "./card-state.ts";
import type { FleetTodoRow } from "../todo-sync/port.ts";

/** Waiting-on view for the fleet-orchestration entry: active runs (spinner on running,
 *  status glyph on queued/paused), the fleet TODO projection, and the optional gate line.
 *  Spinner frame derives from `now` at the 120ms refresh cadence (120ms ticks). */
export function orchestrationLines(runs: RunCardState[], todos: FleetTodoRow[], gate?: string, now: number = Date.now()): string[] {
  const lines: string[] = [];
  const active = runs.filter((r) => r.status === "running" || r.status === "queued");
  lines.push(`${GLYPHS.info} waiting on ${active.length} run${active.length === 1 ? "" : "s"}`);
  active.forEach((r, i) => {
    const last = i === active.length - 1;
    const branch = last ? GLYPHS.treeLeaf : GLYPHS.treeBranch;
    if (r.status === "running") {
      const spin = spinnerFrame(Math.floor((now - r.startedAt) / 120));
      const seg = [spin, r.agent, excerpt(r.task, 40), r.lastEventClass ? `${GLYPHS.eventDot}${r.lastEventClass}` : null]
        .filter(Boolean).join("  ");
      const pct = r.contextTokens != null && r.maxContext ? `  ${Math.round((r.contextTokens / r.maxContext) * 100)}%` : "";
      lines.push(`${branch} ${seg}${pct}`);
    } else {
      lines.push(`${branch} ${GLYPHS.status[r.status]} ${r.agent}  ${r.status}`);
    }
  });
  if (todos.length > 0) {
    lines.push("TODO");
    todos.forEach((t, i) => {
      const last = i === todos.length - 1;
      const box = t.status === "done" ? GLYPHS.todoDone : GLYPHS.todoOpen;
      const name = t.status === "done" ? `${GLYPHS.todoStruck}${t.title}` : t.title;
      lines.push(`${last ? " " : GLYPHS.treeVert}${GLYPHS.treeLine} ${box} ${name}`);
    });
  }
  if (gate) lines.push(`${GLYPHS.waiting} waiting on gate: ${gate}`);
  return lines;
}
