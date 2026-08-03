// SPEC-6-3 §8 — journal hydration. On session start, reconstruct terminal + interrupted
// run rows from journal files so the store reflects historical state after a restart.
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

import type { WorkflowJournal, WorkflowJournalEvent } from "../journal.ts"
import type { WorkflowRunStore } from "./run-store.ts"
import type { WorkflowRunState } from "./types.ts"

export function hydrateWorkflowRuns(
  journal: WorkflowJournal,
  store: WorkflowRunStore,
): void {
  const dir = (journal as unknown as { dir: string }).dir
  if (!existsSync(dir)) return

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    const runId = f.slice(0, -".jsonl".length)
    const events = journal.replay(runId)
    if (events.length === 0) continue

    const state = buildStateFromEvents(runId, events)
    if (state) store.set(runId, state)
  }
}

function buildStateFromEvents(
  runId: string,
  events: WorkflowJournalEvent[],
): WorkflowRunState | undefined {
  let startedEvent: Extract<WorkflowJournalEvent, { type: "wf:started" }> | undefined
  let lastProgress: Extract<WorkflowJournalEvent, { type: "wf:progress" }> | undefined
  let terminalEvent:
    | Extract<WorkflowJournalEvent, { type: "wf:completed" }>
    | Extract<WorkflowJournalEvent, { type: "wf:aborted" }>
    | undefined

  for (const e of events) {
    if (e.type === "wf:started") {
      startedEvent = e
    } else if (e.type === "wf:progress") {
      lastProgress = e
    } else if (e.type === "wf:completed" || e.type === "wf:aborted") {
      terminalEvent = e
    }
  }

  if (!startedEvent) return undefined

  const script = startedEvent.script
  const mode = startedEvent.mode
  const startedAt = startedEvent.ts

  // Base fields from the latest progress snapshot (if any).
  const currentPhase = lastProgress?.currentPhase ?? "default"
  const phases = lastProgress?.phases ?? []
  const childRunIds = lastProgress?.childRunIds ?? []
  const logs = lastProgress?.logs ?? []
  const tokenTotal = lastProgress?.tokenTotal ?? 0
  const costTotal = lastProgress?.costTotal ?? 0

  if (terminalEvent) {
    if (terminalEvent.type === "wf:completed") {
      return {
        runId,
        name: runId,
        script,
        mode,
        status: "completed",
        startedAt,
        endedAt: terminalEvent.ts,
        currentPhase,
        phases,
        childRunIds,
        logs,
        tokenTotal: terminalEvent.tokenTotal ?? tokenTotal,
        costTotal: terminalEvent.costTotal ?? costTotal,
        ...(terminalEvent.result !== undefined ? { result: terminalEvent.result } : {}),
      }
    }
    // wf:aborted
    return {
      runId,
      name: runId,
      script,
      mode,
      status: "aborted",
      startedAt,
      endedAt: terminalEvent.ts,
      currentPhase,
      phases,
      childRunIds,
      logs,
      tokenTotal,
      costTotal,
      error: terminalEvent.reason,
    }
  }

  // Non-terminal: interrupted.
  return {
    runId,
    name: runId,
    script,
    mode,
    status: "interrupted",
    startedAt,
    currentPhase,
    phases,
    childRunIds,
    logs,
    tokenTotal,
    costTotal,
  }
}
