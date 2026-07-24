// src/runtime/run-journal.ts
// SPEC-5a §5 — JSONL run journal. Append-only (crash-safe: a partial last line is discarded).
// The event log IS the i:Info timeline + the resume source of truth.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RunStartedEvent { type: "run:started"; runId: string; task: string; lifecycle: string; worktree: { path: string; branch: string }; mode: "auto" | "checkpointed"; ts: number; }
export interface PhaseStartedEvent { type: "phase:started"; phase: string; ts: number; }
export interface PhaseCompletedEvent { type: "phase:completed"; phase: string; summary: string; paths: string[]; ts: number; }
export interface PhaseFailedEvent { type: "phase:failed"; phase: string; error: string; ts: number; }
export interface CheckpointEvent { type: "checkpoint"; phase: string; decision: "continue" | "revise" | "abort"; ts: number; }
export interface RunCompletedEvent { type: "run:completed"; runId: string; branch: string; ts: number; }
export interface RunAbortedEvent { type: "run:aborted"; runId: string; reason: string; ts: number; }

export type JournalEvent =
  | RunStartedEvent | PhaseStartedEvent | PhaseCompletedEvent | PhaseFailedEvent
  | CheckpointEvent | RunCompletedEvent | RunAbortedEvent;

const TERMINAL = new Set<JournalEvent["type"]>(["run:completed", "run:aborted"]);

export class RunJournal {
  constructor(private readonly dir: string) {}

  private file(runId: string): string {
    return join(this.dir, `${runId}.jsonl`);
  }

  append(runId: string, event: JournalEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(runId), JSON.stringify(event) + "\n", "utf8");
  }

  replay(runId: string): JournalEvent[] {
    const f = this.file(runId);
    if (!existsSync(f)) return [];
    const lines = readFileSync(f, "utf8").split("\n");
    const events: JournalEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch {
        // partial last line (crash mid-append) — discard
      }
    }
    return events;
  }

  scanNonTerminal(): string[] {
    if (!existsSync(this.dir)) return [];
    const ids: string[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const runId = f.slice(0, -".jsonl".length);
      const events = this.replay(runId);
      const last = events[events.length - 1];
      if (last && !TERMINAL.has(last.type)) ids.push(runId);
    }
    return ids;
  }
}