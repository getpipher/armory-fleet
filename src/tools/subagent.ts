// src/tools/subagent.ts
import { Type, type Static } from "typebox";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
import type { SpawnResult } from "../engine/spawnSubagent.ts";
import { spawnSubagent } from "../engine/spawnSubagent.ts";
import type { BackendRegistry } from "../backend/port.ts";

export const subagentParams = Type.Object({
  agent: Type.String({ description: "Agent name from the registry (builtin, project, or global)." }),
  task: Type.String({ description: "The prompt to hand the child subagent." }),
  todoId: Type.Optional(Type.String({ description: "Explicit link to an existing open/in_progress armory-todo todo. Omit to create a fleet task." })),
  track: Type.Optional(Type.Boolean({ description: "Default true. Pass false only for throwaway lookups that don't represent real work." })),
  model: Type.Optional(Type.String({ description: 'Override the agent model, e.g. "anthropic/claude-sonnet-4".' })),
});

export type SubagentInput = Static<typeof subagentParams>;

export interface SubagentToolDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory
  parentModel: { provider: string; id: string };
  parentCwd: string;
}

/** Build the pi.registerTool definition. Thin wrapper over spawnSubagent. */
export function createSubagentTool(deps: SubagentToolDeps) {
  return {
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a named armory-native subagent (foreground, synchronous). The run is tracked in armory-todo by default.",
    promptSnippet: "Delegate a focused task to a subagent",
    promptGuidelines: [
      "Use subagent to delegate an isolated, well-scoped task to a named agent; it runs in the foreground and returns the result + a runId.",
      "Pass todoId to link the run to an existing open todo you see in the Open TODOs block; otherwise fleet creates a tracked fleet task.",
      "Pass track:false only for trivial throwaway lookups that don't represent real work.",
    ],
    parameters: subagentParams,
    async execute(_toolCallId: string, params: SubagentInput, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const res: SpawnResult = await spawnSubagent({
        agent: params.agent,
        task: params.task,
        todoId: params.todoId,
        track: params.track,
        model: params.model,
        registry: deps.registry,
        todoSync: deps.todoSync,
        runRegistry: deps.runRegistry,
        lock: deps.lock,
        backendRegistry: deps.backendRegistry,
        parentModel: deps.parentModel,
        parentCwd: deps.parentCwd,
        signal,
        onEvent: (e) => {
          if (ctx?.ui?.setWidget && e.type === "turn_end") {
            ctx.ui.setWidget("fleet", [`▶ ${params.agent} · running`]);
          }
        },
      });
      const isError = res.status === "failed" || res.status === "aborted";
      return {
        content: [{ type: "text" as const, text: isError ? (res.error ?? res.status) : res.finalText }],
        details: {
          runId: res.runId, todoId: res.todoId, agent: res.agent, model: res.model,
          status: res.status, durationMs: res.durationMs, tokenTotal: res.tokenTotal,
        },
        isError,
      };
    },
  };
}