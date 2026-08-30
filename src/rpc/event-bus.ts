// src/rpc/event-bus.ts
// SPEC-6-4 — FleetEventBus: translates RunLog/RunJournal appends into the public fleet:*
// taxonomy. THE FROZEN SURFACE LIVES HERE: channel names + envelope shapes are pinned by
// test/fleet-event-bus.test.mts — change them and every consumer breaks loudly.
//
// Seq spaces: one per source store (RunLog event order / journal event order), per run.
// Replay (RpcServer) reconstructs identical seqs by walking the same orders — consumers
// dedupe live-vs-replay by (channel, runId, seq).
import type { RunJournal, JournalEvent } from "../runtime/run-journal.ts";
import type { RunLog, RunLogEvent } from "../runtime/run-log.ts";

export type FleetChannel =
  | "fleet:run:started" | "fleet:run:ended"
  | "fleet:phase:started" | "fleet:phase:completed" | "fleet:phase:failed"
  | "fleet:child:message" | "fleet:child:tool";

export interface FleetEnvelope {
  runId: string;
  seq: number;
  /** Publish time (Date.now() at translation) — not the event's own timestamp. */
  ts: number;
  [key: string]: unknown;
}

export interface FleetEventBusDeps {
  runLog: Pick<RunLog, "subscribe">;
  journal: Pick<RunJournal, "subscribe">;
  /** Transport seam. In-process = (c, p) => pi.events.emit(c, p). A future external bridge
   *  re-implements ONLY this — the taxonomy above is its wire format. */
  emit: (channel: FleetChannel, payload: FleetEnvelope) => void;
}

interface MetaLike { startedAt: number }

export class FleetEventBus {
  private readonly runSeq = new Map<string, number>();
  private readonly phaseSeq = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly deps: FleetEventBusDeps) {
    this.unsubs.push(
      deps.runLog.subscribe((runId, event) => this.safe(() => this.onRunLogEvent(runId, event))),
      deps.journal.subscribe((runId, event) => this.safe(() => this.onJournalEvent(runId, event))),
    );
  }

  /** Unsubscribe from both stores. Call from session_shutdown. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /** A bus failure must never break a run's append path. */
  private safe(fn: () => void): void {
    try { fn(); } catch { /* swallow: telemetry must not kill the product */ }
  }

  private next(map: Map<string, number>, runId: string): number {
    const n = (map.get(runId) ?? 0) + 1;
    map.set(runId, n);
    return n;
  }

  private publish(channel: FleetChannel, runId: string, seq: number, payload: Record<string, unknown>): void {
    this.deps.emit(channel, { runId, seq, ts: Date.now(), ...payload });
  }

  private onRunLogEvent(runId: string, e: RunLogEvent): void {
    const seq = this.next(this.runSeq, runId);
    if (e.type === "run:meta") {
      this.startedAt.set(runId, e.startedAt);
      this.publish("fleet:run:started", runId, seq, {
        agent: e.agent, model: e.model, cwd: e.cwd, sessionCwd: e.sessionCwd,
        mode: e.mode ?? "foreground", task: e.task,
      });
    } else if (e.type === "message") {
      this.publish("fleet:child:message", runId, seq, { role: e.role, text: e.text });
    } else if (e.type === "tool") {
      this.publish("fleet:child:tool", runId, seq, { toolName: e.toolName, args: e.args, result: e.result, isError: e.isError });
    } else if (e.type === "run:ended") {
      const start = this.startedAt.get(runId);
      this.publish("fleet:run:ended", runId, seq, {
        status: e.status,
        ...(e.resultSummary !== undefined ? { result: e.resultSummary } : {}),
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.filesTouched !== undefined ? { filesTouched: e.filesTouched } : {}),
        ...(e.toolCallCount !== undefined ? { toolCallCount: e.toolCallCount } : {}),
        ...(start !== undefined ? { durationMs: e.endedAt - start } : {}),
      });
    }
  }

  private onJournalEvent(runId: string, e: JournalEvent): void {
    // Only the phase tier is public; run:started/completed/aborted/checkpoint/agent:*/helper:*
    // stay internal (run-level events come from RunLog, which every spawn writes).
    if (e.type === "phase:started") {
      this.publish("fleet:phase:started", runId, this.next(this.phaseSeq, runId), { phase: e.phase });
    } else if (e.type === "phase:completed") {
      this.publish("fleet:phase:completed", runId, this.next(this.phaseSeq, runId), { phase: e.phase, summary: e.summary, paths: e.paths });
    } else if (e.type === "phase:failed") {
      this.publish("fleet:phase:failed", runId, this.next(this.phaseSeq, runId), { phase: e.phase, error: e.error });
    }
  }
}
