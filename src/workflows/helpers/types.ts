import type { WorkflowJournal } from "../journal.ts";

export interface HelperSpawnResult {
  finalText: string;
  runId: string;
  status: "completed" | "failed";
  costTotal?: number;
}

export interface HelperCtx {
  spawn: (prompt: string, opts?: { agent?: string; tier?: string; model?: string }) => Promise<HelperSpawnResult | null>;
  journal: WorkflowJournal;
  runId: string;
  budget?: { spent: () => number; remaining: () => number };
  onCheckpoint?: (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;
  getModelContextWindow?: (model: string) => number | undefined;
  nextCallIndex: () => number;
}
