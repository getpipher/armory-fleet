// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createSubagentTool, type SubagentToolDeps } from "./tools/subagent.ts";
import { openFleetPanel } from "./panel/fleet-panel.ts";
import { discoverAgents } from "./registry/discovery.ts";
import { RunRegistry } from "./engine/run-registry.ts";
import { createSingleSlotLock } from "./engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "./todo-sync/adapter.ts";
import { ArmoryMemoryAdapter } from "./memory-hydrate/adapter.ts";
import { ArmoryVisionAdapter } from "./vision/adapter.ts";
import { buildChildLoader } from "./engine/child-loader.ts";
import { createDescribeImageTool } from "./vision/describe-image-tool.ts";
import type { MemoryHydratePort } from "./memory-hydrate/port.ts";
import type { VisionPort } from "./vision/port.ts";
import type { ChildSessionFactory, ChildSession } from "./engine/spawnSubagent.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "./backend/port.ts";
import { join } from "node:path";

/** The package builtin agents/ dir, resolved relative to this module. */
function builtinAgentsDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "agents");
}

/** Build the real (SDK-backed) child-session factory. memoryPort is shared (cwd-agnostic);
 *  the vision adapter is constructed per-spawn (needs the child cwd). */
/** SPEC-3 (minimal, pi-only for now; Task 12 adds claude detection + the CC backend). */
function buildDefaultBackendRegistry(modelRuntime: ModelRuntime): BackendRegistry {
  const reg = new BackendRegistry();
  const pi: Backend = {
    id: "pi",
    factory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter()),
    available: () => true,
    versionInfo: () => null,
    hookParity: PI_HOOK_PARITY,
  };
  reg.register(pi);
  return reg;
}

function createChildSessionFactory(modelRuntime: ModelRuntime, memoryPort: MemoryHydratePort): ChildSessionFactory {
  return {
    async create(opts) {
      let model: Model<any> | undefined;
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        if (slash < 0) throw new Error(`agent model '${opts.model}' must be 'provider/id'`);
        const provider = opts.model.slice(0, slash);
        const id = opts.model.slice(slash + 1);
        model = modelRuntime.getModel(provider, id);
        if (!model) throw new Error(`agent model '${opts.model}' not found in runtime (provider '${provider}', id '${id}')`);
      }
      // Fleet CustomResourceLoader: noExtensions + composed systemPromptOverride (rolePrompt + memory + base) + scoped skills.
      const loader = buildChildLoader({ cwd: opts.cwd, agent: opts.agent, memoryPort });
      await loader.reload();
      // Vision adapter built per-spawn (needs the child cwd); ModelRegistry wraps the shared modelRuntime.
      const visionPort: VisionPort = new ArmoryVisionAdapter({
        modelRegistry: new ModelRegistry(modelRuntime),
        cwd: opts.cwd,
        agentDir: getAgentDir(),
      });
      const injectVision = opts.agent.vision && !visionPort.isMultimodal(model);
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        model,
        thinkingLevel: opts.thinkingLevel,
        tools: opts.tools,
        excludeTools: ["todo"],                       // SPEC-2 §9.1 hardened single-writer guard
        customTools: injectVision ? [createDescribeImageTool(visionPort) as never] : [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        modelRuntime,
      });
      return { session: session as unknown as ChildSession, model: opts.model ?? "" };
    },
  };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const deps: SubagentToolDeps = {
    registry: new Map(),
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    backendRegistry: buildDefaultBackendRegistry(modelRuntime),
    parentModel: { provider: "", id: "" },
    parentCwd: "",
  };

  const refresh = (ctx: { cwd: string; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): void => {
    const r = discoverAgents({
      projectDir: join(ctx.cwd, ".pi", "agents"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"),
      builtinDir: builtinAgentsDir(),
    });
    for (const e of r.errors) ctx.ui.notify(e, "error");
    for (const w of r.warnings) ctx.ui.notify(w, "warning");
    deps.registry = r.agents;
  };

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
    const m = ctx.model;
    deps.parentModel = m ? { provider: m.provider, id: m.id } : { provider: "", id: "" };
    deps.parentCwd = ctx.cwd;
  });

  pi.on("resources_discover", (event, ctx) => {
    if (event.reason === "reload") refresh(ctx);
    return undefined;
  });

  pi.registerTool(createSubagentTool(deps) as never);

  pi.registerCommand("fleet", {
    description: "Open the armory-fleet panel (running + recent subagents + agent registry).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("fleet panel is TUI-only; use the subagent tool in non-interactive modes.", "info");
        return;
      }
      openFleetPanel(deps, ctx as never);
    },
  });
}