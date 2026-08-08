// src/engine/run-registry.ts
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { LiveSessionHandle } from "./spawnSubagent.ts";
import type { BackendId } from "../lifecycle/lifecycle-types.ts";

export interface RunRecord {
  runId: string;
  agent: string;
  model: string;
  task: string;
  track: boolean;
  todoId: string | null;
  status: FleetRunStatus;
  startedAt: number;
  endedAt?: number;
  resultSummary?: string;
  /** Backend-native session id for resume (SPEC-3). */
  backendSessionId?: string | null;
  /** The sessionKey whose resume this run belongs to (SPEC-3). */
  sessionKey?: string | null;
  /** SPEC-5b-1: runId this run resumed from (rehydrated the prior sessionKey + a follow-up). */
  resumedFrom?: string;
  /** SPEC-5b-1: runId this run forked from (fresh re-run with same agent+task). */
  forkedFrom?: string;
  /** SPEC-5b-2: cumulative real tokens (input+output+cacheRead+cacheWrite) — live, updated on each message_end. */
  tokenTotal?: number;
  /** SPEC-6-1: cumulative $ (usage.cost.total) — live, updated on each message_end. */
  costTotal?: number;
  /** SPEC-6-1: latest context tokens (calcContextTokens(usage)) — live snapshot. */
  contextTokens?: number;
  /** #32: context-token snapshot at the end of turn 1 (the armory substrate baseline).
   *  Set once on the first assistant message_end; live-only (not journaled). The widget
   *  compares current contextTokens against this to label the tok/ctx% segment as
   *  "substrate" (flat across turns) vs "work" (growing) — see src/panel/widget-rows.ts. */
  substrateBaseline?: number;
  /** SPEC-6-1: the tier name this run used (for Tiers-view "used by" + per-tier spend). */
  tier?: string;
  /** SPEC-6-2: the cwd this run belongs to (widget cross-cwd filter + reconcile ownership). */
  cwd: string;
  /** SPEC-6-2: the backend (probe dispatch: pi→handle, claude→pid). */
  backend: BackendId;
  /** SPEC-6-2: claude-backend child PID (cross-process liveness probe). */
  pid?: number;
  /** SPEC-5b-4: live session handle while status === "running"; cleared by finishRun.
   *  Transient, in-memory only — never written to RunLog (the journal append constructs
   *  a plain object, not RunRecord). */
  session?: LiveSessionHandle;
  /** #23: liveness — current turn count (1-indexed; live, updated on turn_start). */
  turnCount?: number;
  /** #23: the run's max turn budget (set at spawn; for the widget's `turn N/max`). */
  turnMax?: number;
  /** #23: the last event class seen (e.g. "tool:edit", "assistant", "turn") — liveness only, no content. */
  lastEventClass?: string;
  /** #23: timestamp (ms) of the last event — liveness heartbeat ("are events still arriving?"). */
  lastEventAt?: number;
}

/** runId format: fl-<base36 ms>-<6 random> (SPEC-1 §5.1). */
export function genRunId(): string {
  return "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export type RunRegistryChangeListener = () => void;

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<RunRegistryChangeListener>();

  add(r: RunRecord): void {
    this.runs.set(r.runId, r);
    this.emit();
  }
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  /** Newest-first (by startedAt desc). */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  update(id: string, patch: Partial<Omit<RunRecord, "runId">>): void {
    const r = this.runs.get(id);
    if (r) { this.runs.set(id, { ...r, ...patch }); this.emit(); }
  }
  /** SPEC-5a proper-fix: subscribe to add/update mutations. Returns an unsubscribe fn. */
  subscribe(fn: RunRegistryChangeListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
