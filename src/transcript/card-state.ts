// src/transcript/card-state.ts
// #104: pure RunRecord → RunCardState projection for the tool partial-result channel.
import type { RunRecord } from "../engine/run-registry.ts";

export interface RunCardState {
  runId: string;
  agent: string;
  model: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  turnCount?: number;
  lastEventClass?: string;
  contextTokens?: number;
  maxContext?: number;
  costTotal?: number;
  toolCallCount?: number;
  filesTouched?: number;
  error?: string;
  resultSummary?: string;
  warnings?: string[];
}

export function cardSnapshot(run: RunRecord, overrides: Partial<RunCardState> = {}): RunCardState {
  return {
    runId: run.runId, agent: run.agent, model: run.model, task: run.task,
    status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
    turnCount: run.turnCount, lastEventClass: run.lastEventClass,
    contextTokens: run.contextTokens, costTotal: run.costTotal,
    ...overrides,
  };
}
