// SPEC-6-3 §12 — panel host loop: consumes WorkflowPanelIntent from the panel
// and drives editor/input/confirm around it. Never nests ui.editor inside ui.custom.
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Container } from "@earendil-works/pi-tui"
import type { FleetPanelDeps } from "../panel/fleet-panel.ts"
import type { WorkflowDef } from "./registry.ts"
import type { WorkflowRunState } from "./runtime/types.ts"
import { FleetPanel } from "../panel/fleet-panel.ts"

export type WorkflowPanelIntent =
  | { action: "close" }
  | { action: "run"; definitionName: string; prompt: string }
  | { action: "open-definition"; name: string }
  | { action: "open-child"; runId: string; childRunId: string }
  | { action: "edit-resume"; runId: string }
  | { action: "save"; runId: string }
  | { action: "view-result"; runId: string }
  | { action: "respond"; runId: string }

export interface WorkflowPanelHostContext {
  custom: (factory: (tui: unknown, theme: Theme, kb: unknown, done: () => void) => Container) => void
  editor: (initial: string) => Promise<string>
  input: (prompt: string) => Promise<string>
  confirm: (prompt: string) => Promise<boolean>
  notify: (msg: string, type?: "info" | "warning" | "error") => void
  sendUserMessage: (text: string) => void
}

const MAX_SOURCE_BYTES = 50_000
const MAX_SOURCE_LINES = 2000

function boundSource(source: string): string {
  const lines = source.split("\n")
  if (lines.length > MAX_SOURCE_LINES) {
    return lines.slice(0, MAX_SOURCE_LINES).join("\n") + "\n… (truncated)"
  }
  if (source.length > MAX_SOURCE_BYTES) {
    return source.slice(0, MAX_SOURCE_BYTES) + "… (truncated)"
  }
  return source
}

function boundResult(result: unknown): string {
  let text: string
  try {
    text = JSON.stringify(result) ?? String(result)
  } catch {
    text = String(result)
  }
  return text.slice(0, MAX_SOURCE_BYTES)
}

export async function openWorkflowPanelLoop(
  deps: FleetPanelDeps,
  host: WorkflowPanelHostContext,
): Promise<void> {
  let running = true

  while (running) {
    const intent = await openPanelOnce(deps, host)

    if (!intent || intent.action === "close") {
      running = false
      continue
    }

    switch (intent.action) {
      case "run": {
        if (intent.prompt.trim()) {
          const instruction = `${intent.prompt}\n\nUse the fleet workflow tool (action:'workflow') with the '${intent.definitionName}' workflow to execute this.`
          host.sendUserMessage(instruction)
          running = false
        } else {
          await deps.workflowController.start({
            workflowName: intent.definitionName,
            mode: "checkpointed",
          })
        }
        break
      }

      case "edit-resume": {
        const run = deps.workflowController.getRun(intent.runId)
        if (!run) {
          host.notify(`run '${intent.runId}' not found`, "error")
          break
        }
        const editedSource = await host.editor(run.script)
        await deps.workflowController.editAndResume(intent.runId, editedSource, "checkpointed")
        break
      }

      case "save": {
        const run = deps.workflowController.getRun(intent.runId)
        if (!run) {
          host.notify(`run '${intent.runId}' not found`, "error")
          break
        }
        const name = await host.input("Save-as name?")
        let overwrite = false
        const existing = deps.workflowRegistry.get(name)
        const controllerWithCollision = deps.workflowController as unknown as { saveCollision?: boolean }
        if (existing || controllerWithCollision.saveCollision) {
          overwrite = await host.confirm(`Workflow '${name}' already exists. Overwrite?`)
        }
        deps.workflowController.save({ name, source: run.script, overwrite })
        break
      }

      case "open-definition": {
        const def = deps.workflowRegistry.get(intent.name)
        if (!def) {
          host.notify(`workflow '${intent.name}' not found`, "warning")
          break
        }
        host.notify(`Source: ${def.name}\n${boundSource(def.sourceText)}`, "info")
        break
      }

      case "open-child": {
        host.notify(`Open child run '${intent.childRunId}' from '${intent.runId}' — use the Runs viewer.`, "info")
        break
      }

      case "view-result": {
        const run = deps.workflowController.getRun(intent.runId)
        if (!run) {
          host.notify(`run '${intent.runId}' not found`, "error")
          break
        }
        const resultText = run.result !== undefined ? boundResult(run.result) : "(no result)"
        const logText = run.logs.length > 0 ? run.logs.join("\n") : "(no logs)"
        host.notify(`Result: ${resultText}\n\nLogs:\n${logText}`, "info")
        break
      }

      case "respond": {
        const shouldContinue = await host.confirm("Continue checkpoint?")
        if (shouldContinue) {
          deps.workflowController.respondToCheckpoint(intent.runId, { action: "continue" })
        } else {
          const feedback = await host.input("Revise feedback (blank to abort):")
          if (feedback.trim()) {
            deps.workflowController.respondToCheckpoint(intent.runId, { action: "revise", feedback })
          } else {
            deps.workflowController.respondToCheckpoint(intent.runId, { action: "abort" })
          }
        }
        break
      }
    }
  }
}

function openPanelOnce(
  deps: FleetPanelDeps,
  host: WorkflowPanelHostContext,
): Promise<WorkflowPanelIntent | null> {
  return new Promise((resolve) => {
    let resolved = false
    const safeResolve = (intent: WorkflowPanelIntent | null) => {
      if (resolved) return
      resolved = true
      resolve(intent)
    }
    host.custom((_tui, theme, _kb, done) => {
      const panel = new FleetPanel({
        theme,
        deps,
        onDone: (intent?: WorkflowPanelIntent | null) => {
          safeResolve(intent ?? null)
          done()
        },
        onNotify: (m: string, t?: "info" | "warning" | "error") => host.notify(m, t),
      })
      return panel
    })
  })
}
