// src/lifecycle/lifecycle-types.ts
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { AgentSource } from "../registry/frontmatter.ts";

/** Backend id (mirrors SPEC-3 AgentDef.backend). */
export type BackendId = "pi" | "claude";

/** Lifecycle-wide status (richer than FleetRunStatus: adds checkpoint + revising). */
export type LifecycleStatus = "running" | "checkpoint" | "completed" | "failed" | "aborted";

export type LifecycleMode = "checkpointed" | "auto";

/** A phase definition (parsed from a lifecycle file's frontmatter). */
export interface PhaseDef {
  name: string;
  skills: string[];
  /** Per-phase default agent pin; absent → general-purpose. */
  agent?: string;
  /** Per-phase backend override (Q4=C); absent → lifecycle.backend. */
  backend?: BackendId;
  /** Pause for human review after this phase; default true. Terminal phase omits (no checkpoint). */
  checkpoint?: boolean;
  /** The phase prompt template (parsed from the `## <name>` body section). */
  promptTemplate: string;
}

export interface LifecycleDef {
  name: string;
  description: string;
  /** Lifecycle-wide default backend; absent → "pi". */
  backend: BackendId;
  phases: PhaseDef[];
  source: AgentSource;
  filePath: string;
}

/** The record of one phase's execution (stored on the LifecycleRunRecord). */
export interface PhaseRecord {
  name: string;
  summary: string;
  paths: string[];
  status: FleetRunStatus;
  reviseCount: number;
}

export interface LifecycleRunRecord {
  runId: string;
  lifecycleName: string;
  task: string;
  backend: BackendId;
  mode: LifecycleMode;
  status: LifecycleStatus;
  phases: PhaseRecord[];
  startedAt: number;
  /** Set when the lifecycle reaches a terminal status (completed/failed/aborted). */
  endedAt?: number;
  todoId: string | null;
}

/** Human (or auto) decision at a checkpoint. */
export type CheckpointAction = "continue" | "revise" | "abort";
export interface CheckpointDecision {
  action: CheckpointAction;
  /** Present only when action === "revise". */
  feedback?: string;
}