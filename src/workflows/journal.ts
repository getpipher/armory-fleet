// SPEC-6-3 — the per-workflow positional-call-index journal.
// Append-only JSONL at <dir>/<runId>.jsonl. Crash-safe: a partial last line is discarded.
// Separate from RunLog (per-agent conversations/) and RunJournal (per-lifecycle runs/).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowStartedEvent { type: "wf:started"; runId: string; script: string; args?: unknown; phases?: { title: string }[]; ts: number; }
export interface AgentCallEvent { type: "agent:call"; callIndex: number; label: string; phase: string; prompt: string; opts: Record<string, unknown>; childRunId?: string; ts: number; }
export interface AgentResultEvent { type: "agent:result"; callIndex: number; childRunId: string; result: unknown; status: "completed" | "failed"; costTotal?: number; tokenTotal?: number; ts: number; }
export interface HelperCallEvent { type: "helper:call"; callIndex: number; name: string; args: unknown; ts: number; }
export interface HelperResultEvent { type: "helper:result"; callIndex: number; name: string; result: unknown; ts: number; }
export interface CheckpointEvent { type: "checkpoint"; callIndex: number; prompt: string; response: unknown; ts: number; }
export interface WorkflowCompletedEvent { type: "wf:completed"; runId: string; result: unknown; costTotal?: number; tokenTotal?: number; ts: number; }
export interface WorkflowAbortedEvent { type: "wf:aborted"; runId: string; reason: string; ts: number; }

export type WorkflowJournalEvent =
  | WorkflowStartedEvent | AgentCallEvent | AgentResultEvent | HelperCallEvent
  | HelperResultEvent | CheckpointEvent | WorkflowCompletedEvent | WorkflowAbortedEvent;

const WORKFLOW_TERMINAL = new Set<WorkflowJournalEvent["type"]>(["wf:completed", "wf:aborted"]);

export class WorkflowJournal {
  constructor(private readonly dir: string) {}

  private file(runId: string): string { return join(this.dir, `${runId}.jsonl`); }

  append(runId: string, event: WorkflowJournalEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(runId), JSON.stringify(event) + "\n", "utf8");
    } catch {
      // best-effort: never fail the workflow because the journal couldn't persist.
    }
  }

  replay(runId: string): WorkflowJournalEvent[] {
    const f = this.file(runId);
    if (!existsSync(f)) return [];
    const events: WorkflowJournalEvent[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line) as WorkflowJournalEvent); }
      catch { /* partial last line (crash mid-append) — discard */ }
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
      if (last && !WORKFLOW_TERMINAL.has(last.type)) ids.push(runId);
    }
    return ids;
  }
}
