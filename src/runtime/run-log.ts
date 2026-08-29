// src/runtime/run-log.ts
// SPEC-5b-1 — self-describing per-run conversation log. Append-only JSONL (crash-safe:
// partial last line discarded). One file per run in .pi/fleet/conversations/<runId>.jsonl.
// The Runs tab rebuilds the run list across restarts via scanMeta().
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type FleetRunStatus = "running" | "completed" | "failed" | "aborted";

export interface RunMetaEvent {
  type: "run:meta"; runId: string; agent: string; model: string; task: string;
  startedAt: number; track: boolean; todoId: string | null;
  backendSessionId?: string; sessionKey?: string;
  /** SPEC-6-2: claude child PID (cross-process liveness probe). */
  pid?: number;
  /** SPEC-6-2: the cwd this run belongs to. */
  cwd?: string;
  /** SPEC-6-5: the session cwd the dispatch originated from (= parentCwd). */
  sessionCwd?: string;
}
export interface MessageEvent {
  type: "message"; role: string; text: string;
  usage?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  turnIndex: number;
}
export interface ToolEvent {
  type: "tool"; toolName: string; args: string; result: string; isError: boolean; turnIndex: number;
}
export interface RunEndedEvent {
  type: "run:ended"; runId: string; status: FleetRunStatus; endedAt: number;
  resultSummary?: string; tokenTotal: number; resumedFrom?: string; forkedFrom?: string;
  /** SPEC-6-1: cumulative $ at run end. */
  costTotal?: number;
  /** SPEC-6-1: latest context-token snapshot at run end. */
  contextTokens?: number;
  /** #59: the failure reason on failed runs (post-hoc diagnosability from the journal). */
  error?: string;
  /** #61: executed-tool count (the zero-work premature-return signal, post-hoc too). */
  toolCallCount?: number;
}
export type RunLogEvent = RunMetaEvent | MessageEvent | ToolEvent | RunEndedEvent;

/** Resolved view of a run for the Runs tab (scanMeta result). */
export interface RunMeta {
  runId: string; agent: string; model: string; task: string;
  startedAt: number; track: boolean; todoId: string | null;
  backendSessionId?: string; sessionKey?: string;
  status: FleetRunStatus; endedAt?: number; resultSummary?: string; tokenTotal: number;
  resumedFrom?: string; forkedFrom?: string;
  /** SPEC-6-1: cumulative $ at run end. */
  costTotal?: number;
  /** SPEC-6-1: latest context-token snapshot at run end. */
  contextTokens?: number;
  /** SPEC-6-2: claude child PID. */
  pid?: number;
  /** SPEC-6-2: the cwd this run belongs to. */
  cwd?: string;
  /** SPEC-6-5: the session cwd the dispatch originated from (= parentCwd). */
  sessionCwd?: string;
}

const ARGS_LIMIT = 200;
const RESULT_LIMIT = 500;

/** Truncate to `n` chars with a single `…` ellipsis. Non-string → "". */
export function excerpt(str: string, n: number): string {
  if (typeof str !== "string" || str.length === 0) return "";
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + "…";
}

export class RunLog {
  /** Public so buildRunsIndex + FleetPanel can read `runLog.dir` for the scan. */
  constructor(readonly dir: string) {}

  private file(runId: string): string { return join(this.dir, `${runId}.jsonl`); }

  append(runId: string, event: RunLogEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(runId), JSON.stringify(event) + "\n", "utf8");
    } catch {
      // best-effort: the run is the product; the journal is the index. Never fail the run.
    }
  }

  replay(runId: string): RunLogEvent[] {
    const f = this.file(runId);
    if (!existsSync(f)) return [];
    const events: RunLogEvent[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try { events.push(JSON.parse(line) as RunLogEvent); } catch { /* partial last line */ }
    }
    return events;
  }

  /** Rebuild the durable run list across restarts. Reads each file's run:meta events
   * (latest binding wins for backendSessionId/sessionKey; first wins for startedAt) + the
   * last run:ended (if present). */
  scanMeta(): RunMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: RunMeta[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const runId = f.slice(0, -".jsonl".length);
      const events = this.replay(runId);
      let meta: RunMeta | null = null;
      let ended: RunEndedEvent | null = null;
      for (const e of events) {
        if (e.type === "run:meta") {
          if (!meta) {
            meta = { runId: e.runId, agent: e.agent, model: e.model, task: e.task, startedAt: e.startedAt,
              track: e.track, todoId: e.todoId, backendSessionId: e.backendSessionId, sessionKey: e.sessionKey,
              status: "running", tokenTotal: 0, pid: e.pid, cwd: e.cwd, sessionCwd: e.sessionCwd };
          } else {
            // latest binding wins
            if (e.backendSessionId) meta.backendSessionId = e.backendSessionId;
            if (e.sessionKey) meta.sessionKey = e.sessionKey;
          }
        } else if (e.type === "run:ended") {
          ended = e; // keep the last one
        }
      }
      if (!meta) continue;
      if (ended) {
        meta.status = ended.status; meta.endedAt = ended.endedAt;
        meta.resultSummary = ended.resultSummary; meta.tokenTotal = ended.tokenTotal;
        meta.resumedFrom = ended.resumedFrom; meta.forkedFrom = ended.forkedFrom;
        meta.costTotal = ended.costTotal; meta.contextTokens = ended.contextTokens;
      }
      out.push(meta);
    }
    return out;
  }
}

/** Build a tool event with the excerpt policy: errors-in-full, non-errors excerpted. */
export function buildToolEvent(
  toolName: string, args: unknown, result: unknown, isError: boolean, turnIndex: number,
): ToolEvent {
  const argsStr = typeof args === "string" ? args : JSON.stringify(args);
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  return {
    type: "tool", toolName,
    args: excerpt(argsStr, ARGS_LIMIT),
    result: isError ? resultStr : excerpt(resultStr, RESULT_LIMIT),
    isError, turnIndex,
  };
}