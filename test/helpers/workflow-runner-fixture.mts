import type { WorkflowRunDeps } from "../../src/workflows/runner.ts";
import { WorkflowJournal } from "../../src/workflows/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function deps(overrides: Partial<WorkflowRunDeps> = {}): WorkflowRunDeps {
  return {
    spawn: async (prompt) => ({ finalText: `spawned:${prompt.slice(0, 10)}`, runId: "fl-" + Math.random().toString(36).slice(2, 8), status: "completed" as const, costTotal: 0.1, tokenTotal: 10 }),
    worktree: { isGitRepo: () => true, create: (id) => ({ path: `/tmp/wt-${id}`, branch: `fleet/${id}` }), removeWorktree: () => {}, remove: () => {} },
    tierRegistry: { get: () => undefined },
    journal: new WorkflowJournal(mkdtempSync(join(tmpdir(), "wf-run-"))),
    runRegistry: { get: () => undefined, list: () => [] },
    getModelContextWindow: () => undefined,
    genRunId: () => "wf-" + Math.random().toString(36).slice(2, 8),
    notify: () => {},
    resolveWorkflow: () => undefined,
    ...overrides,
  } as WorkflowRunDeps;
}

export function cleanup(d: WorkflowRunDeps): void {
  rmSync((d.journal as unknown as { dir: string }).dir, { recursive: true, force: true });
}

export function child(finalText: string, runId = "fl-child"): {
  finalText: string;
  runId: string;
  status: "completed";
  tokenTotal: number;
  costTotal: number;
} {
  return { finalText, runId, status: "completed", tokenTotal: 10, costTotal: 0.1 };
}
