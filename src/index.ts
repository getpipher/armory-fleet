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
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "./backend/port.ts";
import { ResumeStore } from "./backend/resume-store.ts";
import { detectClaude } from "./backend/claude-detector.ts";
import { createClaudeChildFactory } from "./backend/claude-factory.ts";
import { join } from "node:path";
import { discoverLifecycles } from "./lifecycle/registry.ts";
import { DEFAULT_LIFECYCLE, builtinLifecyclesDir } from "./lifecycle/default.ts";
import type { LifecycleDef } from "./lifecycle/lifecycle-types.ts";
import type { LifecycleRunDeps } from "./lifecycle/run-lifecycle.ts";

/** The package builtin agents/ dir, resolved relative to this module. */
function builtinAgentsDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "agents");
}

/** Build the real (SDK-backed) child-session factory. memoryPort is shared (cwd-agnostic);
 *  the vision adapter is constructed per-spawn (needs the child cwd). */
/** SPEC-3: wrap a pi SDK session so it emits session_init on subscribe + forwards the rest. */
function wrapPiSession(inner: ChildSession, backendSessionId: string): ChildSession {
  return {
    prompt: (t) => inner.prompt(t),
    abort: () => inner.abort(),
    dispose: () => inner.dispose(),
    subscribe: (handler) => {
      handler({ type: "session_init", backendSessionId });
      return inner.subscribe(handler);
    },
  };
}

/** SPEC-3: build the BackendRegistry — pi always; claude registered with availability reflecting detectClaude(). */
async function buildDefaultBackendRegistry(modelRuntime: ModelRuntime): Promise<BackendRegistry> {
  const resumeStore = new ResumeStore();
  const claudeInfo = await detectClaude();
  const reg = new BackendRegistry();
  const pi: Backend = {
    id: "pi",
    factory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter(), resumeStore),
    available: () => true,
    versionInfo: () => null,
    hookParity: PI_HOOK_PARITY,
  };
  reg.register(pi);
  // claude is registered regardless of availability so the Backends view can show it; available reflects detection.
  reg.register({
    id: "claude",
    factory: createClaudeChildFactory(claudeInfo, resumeStore),
    available: () => claudeInfo?.schemaOk === true,
    versionInfo: () => claudeInfo,
    hookParity: CLAUDE_HOOK_PARITY,
  });
  return reg;
}

export function createChildSessionFactory(modelRuntime: ModelRuntime, memoryPort: MemoryHydratePort, resumeStore: ResumeStore): ChildSessionFactory {
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
      // SPEC-3 §3.1: file-backed SessionManager so resume works. Resume a prior session when the store has a path.
      const resumePath = resumeStore.get("pi", opts.agent.sessionKey);
      const sessionManager = resumePath ? SessionManager.open(resumePath) : SessionManager.create(opts.cwd);
      const { session: piSession } = await createAgentSession({
        cwd: opts.cwd,
        model,
        thinkingLevel: opts.thinkingLevel,
        tools: opts.tools,
        excludeTools: ["todo"],                       // SPEC-2 §9.1 hardened single-writer guard
        customTools: injectVision ? [createDescribeImageTool(visionPort) as never] : [],
        resourceLoader: loader,
        sessionManager,
        modelRuntime,
      });
      // SPEC-3 §4.3: wrap + emit session_init + persist the session file path for resume.
      const backendSessionId = piSession.sessionFile ?? piSession.sessionId;
      if (piSession.sessionFile) resumeStore.set("pi", opts.agent.sessionKey, piSession.sessionFile);
      const session: ChildSession = wrapPiSession(piSession as unknown as ChildSession, backendSessionId);
      return { session, model: opts.model ?? "" };
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
    backendRegistry: await buildDefaultBackendRegistry(modelRuntime),
    parentModel: { provider: "", id: "" },
    parentCwd: "",
    lifecycleRegistry: new Map<string, LifecycleDef>(),
    lifecycleRuns: new Map<string, import("./lifecycle/lifecycle-types.ts").LifecycleRunRecord>(),
    lifecycleDeps: {
      registry: new Map(),          // wired to the real agent registry in refreshLifecycles (Task 12)
      agentRegistry: new Map(),     // ditto
      todoPort: new ArmoryTodoAdapter(),
      resolveBackend: (phaseBackend, lifecycleBackend) => {
        const id = phaseBackend ?? lifecycleBackend;
        if (id === "claude" && !deps.backendRegistry.get("claude")?.available()) {
          throw new Error("phase requests backend 'claude' but claude is not installed; run 'claude' to set up, or change the phase backend in the lifecycle file");
        }
        return id;
      },
      genRunId: () => "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    },
  };
  // Seed the builtin `default` lifecycle + wire lifecycleDeps to the live registries.
  deps.lifecycleRegistry.set(DEFAULT_LIFECYCLE.name, DEFAULT_LIFECYCLE);
  deps.lifecycleDeps.registry = deps.lifecycleRegistry;
  deps.lifecycleDeps.agentRegistry = deps.registry;

  const refresh = (ctx: { cwd: string; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): void => {
    const r = discoverAgents({
      projectDir: join(ctx.cwd, ".pi", "agents"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"),
      builtinDir: builtinAgentsDir(),
    });
    for (const e of r.errors) ctx.ui.notify(e, "error");
    for (const w of r.warnings) ctx.ui.notify(w, "warning");
    // Mutate in place (not replace the reference) so lifecycleDeps.agentRegistry — which is bound
    // to this same Map once at init — stays live across refreshes (SPEC-4 fix).
    deps.registry.clear();
    for (const [k, v] of r.agents) deps.registry.set(k, v);
  };

  const refreshLifecycles = (ctx: { cwd: string; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): void => {
    const r = discoverLifecycles({
      projectDir: join(ctx.cwd, ".pi", "lifecycles"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "lifecycles"),
      builtinDir: builtinLifecyclesDir(),
    });
    for (const e of r.errors) ctx.ui.notify(e, "error");
    for (const w of r.warnings) ctx.ui.notify(w, "warning");
    deps.lifecycleRegistry.clear();
    deps.lifecycleRegistry.set(DEFAULT_LIFECYCLE.name, DEFAULT_LIFECYCLE);
    for (const [name, def] of r.lifecycles) deps.lifecycleRegistry.set(name, def);
  };

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
    refreshLifecycles(ctx);
    const m = ctx.model;
    deps.parentModel = m ? { provider: m.provider, id: m.id } : { provider: "", id: "" };
    deps.parentCwd = ctx.cwd;
  });

  pi.on("resources_discover", (event, ctx) => {
    if (event.reason === "reload") { refresh(ctx); refreshLifecycles(ctx); }
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

  // SPEC-4: /fleet-implement <task> [--lifecycle <name>] [--auto] — the done-bar slash.
  const parseImplementArgs = (args: string): { task: string; lifecycle?: string; auto?: boolean } => {
    const parts = String(args ?? "").trim().split(/\s+/);
    let lifecycle: string | undefined; let auto = false; const taskParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--lifecycle") { lifecycle = parts[++i]; continue; }
      if (parts[i] === "--auto") { auto = true; continue; }
      taskParts.push(parts[i]!);
    }
    return { task: taskParts.join(" ").trim(), lifecycle, auto };
  };

  pi.registerCommand("fleet-implement", {
    description: "Run a task through the superpowers lifecycle (default). Flags: --lifecycle <name>, --auto.",
    handler: async (args, ctx) => {
      const parsed = parseImplementArgs(args);
      const lcName = parsed.lifecycle ?? "default";
      if (!parsed.task) { ctx.ui.notify("usage: /fleet-implement <task> [--lifecycle <name>] [--auto]", "warning"); return; }
      if (!deps.lifecycleRegistry.has(lcName)) {
        ctx.ui.notify(`lifecycle '${lcName}' not found; available: ${[...deps.lifecycleRegistry.keys()].sort().join(", ")}`, "error");
        return;
      }
      const { runLifecycle } = await import("./lifecycle/run-lifecycle.ts");
      const { spawnSubagent } = await import("./engine/spawnSubagent.ts");
      const onCheckpoint: import("./lifecycle/run-lifecycle.ts").CheckpointFn = parsed.auto
        ? async (_phase) => ({ action: "continue" })
        : async (phase) => {
            // Non-TUI / non-auto: can't prompt interactively → auto-continue + notify (open /fleet for interactive).
            ctx.ui.notify(`lifecycle checkpoint at '${phase.name}' — open /fleet Lifecycle view to Continue/Revise/Abort (auto-continuing)`, "info");
            return { action: "continue" };
          };
      const lifecycleFullDeps: import("./lifecycle/run-lifecycle.ts").LifecycleRunDeps = {
        ...deps.lifecycleDeps,
        spawn: async (o) => spawnSubagent({
          agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
          registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
          backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd,
        }),
      };
      const res = await runLifecycle(parsed.task, lcName, { deps: lifecycleFullDeps, mode: parsed.auto ? "auto" : "checkpointed", onCheckpoint });
      deps.lifecycleRuns.set(res.runId, res);
      ctx.ui.notify(`lifecycle ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
    },
  });
}