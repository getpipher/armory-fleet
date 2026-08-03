// SPEC-6-3 runtime types — public state shapes consumed by the runner, store, panel, and later tasks.

export type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "checkpoint"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export interface WorkflowRunState {
  runId: string;
  name: string;
  script: string;
  args?: unknown;
  mode: "auto" | "checkpointed";
  status: WorkflowStatus;
  startedAt: number;
  endedAt?: number;
  currentPhase: string;
  phases: Array<{ title: string; agents: number; cached: number; reRun: number }>;
  childRunIds: string[];
  logs: string[];
  tokenTotal: number;
  costTotal: number;
  result?: unknown;
  error?: string;
  resumeFromRunId?: string;
  checkpoint?: { prompt: string; opts: Record<string, unknown> };
}

export interface WorkflowProgressEvent {
  kind:
    | "started"
    | "phase"
    | "child-started"
    | "child-completed"
    | "child-failed"
    | "helper-started"
    | "helper-completed"
    | "log"
    | "checkpoint"
    | "checkpoint-resolved"
    | "completed"
    | "failed"
    | "aborted";
  runId: string;
  snapshot: WorkflowRunState;
}

export interface WorkflowStartInput {
  script?: string;
  workflowName?: string;
  name?: string;
  overwrite?: boolean;
  args?: unknown;
  mode: "auto" | "checkpointed";
  background?: boolean;
  resumeFromRunId?: string;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
}

export interface WorkflowStartReceipt {
  runId: string;
  status: "background";
}

export interface WorkflowSaveInput {
  name: string;
  source: string;
  overwrite?: boolean;
}
