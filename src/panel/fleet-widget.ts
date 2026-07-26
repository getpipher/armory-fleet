// src/panel/fleet-widget.ts
// SPEC-5b-2 — the live widget (above editor) + FleetView (below editor) controller.
//
// Display-only (Q1=A): pi widgets render into a layout container; the editor keeps keyboard
// focus. No input is routed here — /fleet is the action surface.
//
// Lifecycle (Q5/Q6/Q7=A): visible only while ≥1 active run exists; hidden when idle (editor
// reclaims both slots). A 1s setInterval re-renders for the live duration clock; it starts
// lazily on the first active render and clears when the fleet goes idle + on dispose.
//
// Independent of the /fleet panel: constructed at session_start in index.ts, persists whether
// the panel is open or closed.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { BgRunsStore } from "./bg-runs-store.ts";
import {
  toWidgetRun, toWidgetRunFromBg, renderWidgetLines, renderFleetViewLines,
} from "./widget-rows.ts";

const WIDGET_KEY = "fleet-active";
const VIEW_KEY = "fleet-view";

export interface FleetWidgetDeps {
  runRegistry: RunRegistry;
  bgRuns?: BgRunsStore;
  ui: {
    setWidget: (
      key: string,
      content: string[] | undefined,
      opts?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
  /** Live theme getter (EditorTheme gotcha: never capture a factory theme arg). */
  getTheme: () => Theme;
  /** Injectable clock + timers for testability. Default to globals. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export class FleetWidgetController {
  private readonly deps: FleetWidgetDeps;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (id: unknown) => void;
  private readonly unsubs: (() => void)[] = [];
  private timerId: unknown | null = null;
  private disposed = false;

  constructor(deps: FleetWidgetDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((id) => globalThis.clearInterval(id as any));
  }

  start(): void {
    this.unsubs.push(this.deps.runRegistry.subscribe(() => this.render()));
    if (this.deps.bgRuns) this.unsubs.push(this.deps.bgRuns.subscribe(() => this.render()));
    this.render(); // initial — shows any runs already active on session_start (e.g. a survived bg run)
  }

  private activeRuns() {
    const fg = this.deps.runRegistry.list().map(toWidgetRun);
    const bg = this.deps.bgRuns ? [...this.deps.bgRuns.values()].map(toWidgetRunFromBg) : [];
    return [...fg, ...bg];
  }

  render(): void {
    if (this.disposed) return;
    const active = this.activeRuns();
    const hasActive = active.some((r) => r.status === "running" || r.status === "queued" || r.status === "paused");
    if (!hasActive) {
      this.clearTimer();
      this.setBoth(undefined);
      return;
    }
    this.ensureTimer();
    const now = this.now();
    try {
      this.deps.ui.setWidget(WIDGET_KEY, renderWidgetLines(active, now));
    } catch { /* best-effort: a render failure never affects runs */ }
    try {
      this.deps.ui.setWidget(VIEW_KEY, renderFleetViewLines(active, now), { placement: "belowEditor" });
    } catch { /* best-effort */ }
  }

  private setBoth(content: string[] | undefined): void {
    try { this.deps.ui.setWidget(WIDGET_KEY, content); } catch { /* best-effort */ }
    try { this.deps.ui.setWidget(VIEW_KEY, content, { placement: "belowEditor" }); } catch { /* best-effort */ }
  }

  private ensureTimer(): void {
    if (this.timerId !== null) return;
    this.timerId = this.setIntervalFn(() => this.render(), 1000);
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      this.clearIntervalFn(this.timerId);
      this.timerId = null;
    }
  }

  /** Unsubscribe + clear timer + clear both widgets. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.setBoth(undefined);
  }
}