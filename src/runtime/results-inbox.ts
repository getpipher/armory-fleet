// src/runtime/results-inbox.ts
// SPEC-5a §10 — in-memory results inbox for completed bg runs (Q6=C).
// The durable record is the lifecycle TODO notes + journal; this is the fast in-session
// pointer the agent pulls via fleet.results().

export interface RunResult {
  runId: string;
  task: string;
  status: "completed" | "failed";
  summary: string;
  paths: string[];
  branch?: string;
  completedAt: number;
}

export class ResultsInbox {
  private ready = new Map<string, RunResult>();

  push(result: RunResult): void {
    this.ready.set(result.runId, result);
  }

  readyCount(): number {
    return this.ready.size;
  }

  pull(runId?: string): RunResult[] {
    if (runId) {
      const r = this.ready.get(runId);
      if (!r) return [];
      this.ready.delete(runId);
      return [r];
    }
    const all = [...this.ready.values()];
    this.ready.clear();
    return all;
  }

  /** Bounded hint for the parent agent's context: cap at 5, one line, empty when nothing ready. */
  renderHint(): string {
    const n = this.ready.size;
    if (n === 0) return "";
    return n > 5 ? "5+ fleet results ready (use fleet.results to pull)" : `${n} fleet result${n > 1 ? "s" : ""} ready (use fleet.results to pull)`;
  }
}