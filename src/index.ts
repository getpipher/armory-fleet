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
// SPEC-6-3: /fleet uses openWorkflowPanelLoop (Task 12) instead of the raw openFleetPanel factory.
import { discoverAgents } from "./registry/discovery.ts";
import { RunRegistry } from "./engine/run-registry.ts";
import { createSingleSlotLock, createForegroundLock } from "./engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "./todo-sync/adapter.ts";
import { ArmoryMemoryAdapter } from "./memory-hydrate/adapter.ts";
import { ArmoryVisionAdapter } from "./vision/adapter.ts";
import { buildChildLoader } from "./engine/child-loader.ts";
import { withModelFallbackRetry } from "./engine/retry-fallback.ts";
import { resolveAutoFallback } from "./engine/auto-fallback.ts";
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
import { WorktreeService } from "./worktree/worktree-service.ts";
import { DiffService } from "./worktree/diff-service.ts";
import { RunJournal } from "./runtime/run-journal.ts";
import { ConcurrencyPool } from "./runtime/concurrency-pool.ts";
import { ResultsInbox } from "./runtime/results-inbox.ts";
import { runBackground, type AsyncRunnerDeps } from "./runtime/async-runner.ts";
import { scanResumeCandidates } from "./runtime/resume.ts";
import { RunLog } from "./runtime/run-log.ts";
import { reconcileRuns } from "./runtime/reconcile.ts";
import { Scheduler } from "./scheduling/scheduler.ts";
import { createFleetResultsTool } from "./tools/fleet-results.ts";
import { BgRunsStore } from "./panel/bg-runs-store.ts";
import { GateRegistry } from "./lifecycle/gates/registry.ts";
import { registerBuiltinGates } from "./lifecycle/gates/builtin.ts";
import { FleetWidgetController } from "./panel/fleet-widget.ts";
import { TierRegistry, mergeTiers } from "./tiers/tier-registry.ts";
import { BUILTIN_TIERS } from "./tiers/builtin.ts";
import { TierStore } from "./tiers/tier-store.ts";
import { splitModel } from "./tiers/resolve.ts";
import { WorkflowJournal } from "./workflows/journal.ts";
import { discoverWorkflows, WorkflowRegistry, type WorkflowDef } from "./workflows/registry.ts";
import { runWorkflow, type WorkflowRunDeps, type WorkflowRunResult } from "./workflows/runner.ts";
import { scanWorkflowResumeCandidates } from "./runtime/reconcile.ts";
import { WorkflowController } from "./workflows/runtime/controller.ts";
import { WorkflowRunStore } from "./workflows/runtime/run-store.ts";
import { createWorkflowAdapters } from "./workflows/runtime/adapters.ts";
import { openWorkflowPanelLoop } from "./workflows/panel-host.ts";
import { workflowKeywordHint } from "./workflows/keyword.ts";
import { createFleetTool } from "./tools/fleet.ts";

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
    // SPEC-5b-4: forward the native SDK steer + isStreaming to the real pi session.
    steer: (t) => inner.steer ? inner.steer(t) : Promise.reject(new Error("pi session has no steer")),
    get isStreaming() { return inner.isStreaming ?? false; },
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

/**
 * Format the runtime's available models for the #57 self-correcting error message:
 * dedup `provider/id` pairs, cap the list (min 1 — a non-empty input always lists
 * something), actionable hint when empty.
 */
export function formatAvailableModels(models: readonly { provider: string; id: string }[], cap = 12): string {
  const effectiveCap = Math.max(1, cap);
  const seen = new Set<string>();
  const list: string[] = [];
  for (const m of models) {
    const ref = `${m.provider}/${m.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (list.length < effectiveCap) list.push(ref);
  }
  if (list.length === 0) return "(none — check provider auth / models.json)";
  const omitted = seen.size - list.length;
  return list.join(", ") + (omitted > 0 ? ` … +${omitted} more` : "");
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
        // #57: name what IS usable so the orchestrating model can self-correct on retry.
        if (!model) {
          throw new Error(
            `agent model '${opts.model}' not found in runtime (provider '${provider}', id '${id}'). ` +
            `Available: ${formatAvailableModels(modelRuntime.getAvailableSnapshot())} — pick one of these for the model param`,
          );
        }
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

/** #31 tail: parse the foreground-concurrency cap from `ARMORY_FLEET_FOREGROUND_CONCURRENCY`.
 *  Default 1 (fail-fast, backward-compat). >1 enables a queueing pool (up to N parallel write
 *  dispatches). Clamped to [1, 64]; invalid/empty → 1. */
function parseForegroundConcurrency(): number {
  const raw = process.env.ARMORY_FLEET_FOREGROUND_CONCURRENCY;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 64);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const deps: SubagentToolDeps = {
    registry: new Map(),
    runRegistry: new RunRegistry(),
    lock: createForegroundLock(parseForegroundConcurrency()),
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

  // SPEC-6-1: shared model registry for contextWindow lookups (contextFloor + ctx% widget).
  const sharedModelRegistry = new ModelRegistry(modelRuntime);
  deps.modelRegistry = sharedModelRegistry;
  // Builtin-only placeholder tier registry so spawn works before session_start rebuilds with merged tiers.
  deps.tierRegistry = new TierRegistry({ tiers: BUILTIN_TIERS, agents: deps.registry });

  // #39 tail: global default fallback model (env-driven for now; a settings.json field is a follow-up).
  // A retryable provider failure (stopReason "error") retries once on this model even without a
  // per-dispatch `modelFallback`. Per the AGENTS.md "Ollama primary + OpenRouter fallback" pattern.
  // #39 tail + #58: the global default fallback. Non-"auto" env values are used verbatim;
  // "auto" is resolved per-session in session_start (it needs the session model to differ from).
  const rawModelFallback = process.env.ARMORY_FLEET_MODEL_FALLBACK || undefined;
  deps.defaultModelFallback = rawModelFallback === "auto" ? undefined : rawModelFallback;
  // SPEC-6-5: cross-cwd dispatch notify hook (wired per-session in session_start below).
  // Placeholder; the real wiring happens in session_start where ctx is in scope.

  // #31 tail: foreground concurrency is SESSION-LEVEL (a shared lock can't be re-sized per
  // dispatch). cap=1 (default) is fail-fast (backward-compat); cap>1 enables a queueing pool so
  // up to `cap` write dispatches run in parallel. readOnly dispatches bypass the lock (#41).

  // SPEC-6-2: gate registry + builtin gate registration.
  const gateRegistry = new GateRegistry();
  registerBuiltinGates(gateRegistry);
  // Wire gate deps into lifecycleDeps (both the async + foreground lifecycle sites spread from lifecycleDeps).
  deps.lifecycleDeps.gateRegistry = gateRegistry;
  deps.lifecycleDeps.getGateCtxState = (todoId: string, _agentName: string) => {
    const runs = deps.runRegistry.list().filter((r) => r.todoId === todoId);
    const lifecycleCost = runs.reduce((s, r) => s + (r.costTotal ?? 0), 0);
    const contextTokens = runs.reduce((max, r) => Math.max(max, r.contextTokens ?? 0), 0);
    const tierName = runs.find((r) => r.tier)?.tier;
    const tier = tierName ? deps.tierRegistry?.get(tierName) : undefined;
    return { lifecycleCost, contextTokens, tier };
  };

  // ── SPEC-5a: operational runtime (async/bg + scheduling + worktree isolation) ──
  const fleetDir = (cwd: string) => join(cwd, ".pi", "fleet");
  const bgRuns = new BgRunsStore();
  const resultsInbox = new ResultsInbox();
  // SPEC-5b-2: the live widget (above editor) controller.
  // Display-only, independent of the /fleet panel; constructed per-session in session_start.
  let fleetWidget: FleetWidgetController | null = null;
  // SPEC-6-3: hoisted so /fleet command handler + session_shutdown can reach them.
  let wfController: WorkflowController | null = null;
  let wfStore: WorkflowRunStore | null = null;
  let wfRegistry: WorkflowRegistry | null = null;
  let wfSessionAbort: AbortController | null = null;
  // The async runner's runLifecycle adapter: call the real runLifecycle with the worktree as the
  // spawn cwd + override genRunId so the lifecycle runId IS the async runner's runId (Q1=B seam).
  const asyncRunLifecycle: AsyncRunnerDeps["runLifecycle"] = async (task, lifecycleName, opts) => {
    const { runLifecycle } = await import("./lifecycle/run-lifecycle.ts");
    const { spawnSubagent } = await import("./engine/spawnSubagent.ts");
    // SPEC-5a §8.1 (Q4=A): bg runs must NOT compete with the foreground single-slot lock.
    // The ConcurrencyPool gates bg-RUN concurrency (N-slot); within a run the lifecycle loop
    // serializes phases, so a fresh per-run lock just satisfies spawnSubagent's tryAcquire API
    // without ever contending (foreground holds deps.lock; bg holds its own). Without this, a
    // foreground subagent holding deps.lock made every bg run's first-phase spawn fail fast
    // (tryAcquire → "concurrency lock unexpectedly unavailable" → 6ms run:aborted).
    const bgLock = createSingleSlotLock();
    // v0.11.1: isolated runs use worktree-diff artifact discovery + the worktree as spawn cwd;
    // in-place runs (worktreePath undefined) use the prompt-baked parser + the session cwd.
    const isolated = !!opts.worktreePath;
    const lifecycleFullDeps: LifecycleRunDeps = {
      ...deps.lifecycleDeps,
      genRunId: () => opts.runId,   // override: use the async runner's runId
      ...(isolated ? { artifactDiscovery: ({ finalText, cwd, baseRef }: { finalText: string; cwd: string; baseRef: string }) => (deps.asyncRunner as AsyncRunnerDeps).diff.diffPhase(cwd, baseRef, finalText) } : {}),
      spawn: withModelFallbackRetry(async (o) => spawnSubagent({
        agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
        mode: opts.fleetMode ?? "background",
        skillsOverride: o.skills, backendOverride: o.backend,
        registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: bgLock,
        backendRegistry: deps.backendRegistry, parentModel: deps.parentModel,
        parentCwd: isolated ? opts.worktreePath! : deps.parentCwd,
        // #62: in-place bg runs honor the lifecycle cwd resolution (lifecycle.cwd ?? entryCwd);
        // isolated runs pin the phase cwd to the worktree. parentCwd stays the SESSION cwd for
        // in-place runs so the cross-cwd surfacing (↗ glyph + sessionCwd audit) still fires.
        cwd: isolated ? opts.worktreePath : o.cwd,
        runLog: deps.runLog, tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
      }), deps.defaultModelFallback),
    };
    const res = await runLifecycle(task, lifecycleName, { deps: lifecycleFullDeps, mode: opts.mode, worktreePath: opts.worktreePath, baseRef: "HEAD", entryCwd: opts.entryCwd, onCheckpoint: async (p) => p.status === "failed" ? { action: "abort" } : { action: "continue" } });
    return res as unknown as import("./runtime/async-runner.ts").FakeLifecycleResult;
  };
  // asyncRunnerDeps + scheduler are built per-session (need the session cwd); wired on session_start.
  // At init they're undefined — the subagent tool's `if (!deps.asyncRunner)` guard returns an
  // actionable "not configured" error if called before session_start (can't happen in practice).
  deps.bgRuns = bgRuns;
  // SPEC-5b-1: RunLog is constructed per-session (needs the cwd) in session_start; the
  // shared `deps` reference is mutated there so the subagent tool + panel pick it up live.
  deps.runLog = undefined as RunLog | undefined;

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
    // #58: ARMORY_FLEET_MODEL_FALLBACK=auto — pick a fallback from the configured+available
    // snapshot that differs from the session model (different provider preferred). Unresolvable
    // (single-model setup) → stay off + say why once per session.
    if (rawModelFallback === "auto") {
      deps.defaultModelFallback = resolveAutoFallback(modelRuntime.getAvailableSnapshot(), deps.parentModel);
      if (!deps.defaultModelFallback) {
        ctx.ui.notify("ARMORY_FLEET_MODEL_FALLBACK=auto, but no alternative configured model is available — auto-retry stays off", "warning");
      }
    }
    deps.parentCwd = ctx.cwd;
    deps.onNotify = (m, k) => ctx.ui.notify(m, k ?? "info");
    // SPEC-5a: build the per-session async runner + scheduler, start firing, scan for interrupted runs.
    const dir = fleetDir(ctx.cwd);
    // SPEC-5b-1: per-session RunLog at .pi/fleet/conversations/ (separate from the
    // SPEC-5a phase journal at .pi/fleet/runs/ — different granularity, no filename collision).
    deps.runLog = new RunLog(join(dir, "conversations"));
    // v0.10.2: pass the in-memory RunRegistry so reconcile syncs it too — otherwise orphaned
    // (process-gone) runs keep status:"running" in memory and the live widget shows a stale ▶ forever.
    // #22 bg-watchdog: pass todoSync so a process-gone run's linked TODO is reverted to open
    // (retryable) with a WORKER_EXITED_WITHOUT_RESULT note, not stuck in_progress forever.
    // Fire-and-forget (async) so the asyncRunner setup below isn't blocked.
    void reconcileRuns(deps.runLog, { runRegistry: deps.runRegistry, todoSync: deps.todoSync })
      .then((reconciled) => {
        if (reconciled.length > 0) {
          ctx.ui.notify(`reconciled ${reconciled.length} interrupted fleet run${reconciled.length > 1 ? "s" : ""} (marked aborted; linked TODOs reverted to open)`, "info");
        }
      });
    const sessionWorktree = new WorktreeService({ rootDir: ctx.cwd });
    deps.asyncRunner = {
      worktree: sessionWorktree,
      // #62: cross-cwd bg dispatches get a per-dispatch worktree service rooted at the dispatch
      // cwd, so isolation:'worktree' creates the worktree from the CHILD's repo (the session
      // service would create it from the session's repo — the #62 gap). Same-cwd → shared.
      worktreeFor: (cwd: string) => (cwd === ctx.cwd ? sessionWorktree : new WorktreeService({ rootDir: cwd })),
      diff: new DiffService(),
      journal: new RunJournal(join(dir, "runs")),
      pool: new ConcurrencyPool(3),
      inbox: resultsInbox,
      runLifecycle: asyncRunLifecycle,
      notify: (m, lvl) => ctx.ui.notify(m, lvl),
      genRunId: () => "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      onProgress: (runId, status) => { bgRuns.set(runId, status); },
      runRegistry: deps.runRegistry,
    };
    deps.scheduler = new Scheduler({
      storePath: join(dir, "schedules.json"),
      lockPath: join(dir, "schedules.lock"),
      onFire: (spec) => {
        if (!deps.asyncRunner) return;
        runBackground(spec.task, { deps: deps.asyncRunner, lifecycle: spec.lifecycle ?? "default", mode: spec.auto ? "auto" : "checkpointed", isolation: spec.isolation, cwd: spec.cwd, origin: "scheduled" });
      },
    });
    deps.scheduler.start();
    const cands = scanResumeCandidates(ctx.cwd, { runsDir: join(dir, "runs"), worktree: deps.asyncRunner.worktree });
    if (cands.length > 0) {
      ctx.ui.notify(`${cands.length} interrupted fleet run${cands.length > 1 ? "s" : ""} — open /fleet to resume`, "info");
    }
    // SPEC-5b-2: live widget (above editor). Display-only, independent
    // of the /fleet panel. getTheme is a live getter (EditorTheme gotcha). Disposed on session end.
    const getModelContextWindow = (m: string): number | undefined => {
      const { provider, id } = splitModel(m, deps.parentModel.provider);
      return sharedModelRegistry.find(provider, id)?.contextWindow;
    };
    deps.getModelContextWindow = getModelContextWindow;
    // SPEC-6-2: thread getModelContextWindow into lifecycle deps for gate ctx.
    deps.lifecycleDeps.getModelContextWindow = getModelContextWindow;
    fleetWidget = new FleetWidgetController({
      runRegistry: deps.runRegistry,
      bgRuns,
      ui: ctx.ui as never,
      getTheme: () => ctx.ui.theme,
      getModelContextWindow,
      cwd: ctx.cwd,
      runLog: deps.runLog,
      todoSync: deps.todoSync,  // #22 bg-watchdog: periodic probe reverts process-gone runs' TODOs
    });
    fleetWidget.start();

    // SPEC-6-1: per-session TierStore (cwd-aware project path) + real TierRegistry (builtins + global + project).
    const tierStore = new TierStore({
      projectPath: join(dir, "tiers.json"),
      globalPath: join(process.env.HOME ?? "", ".pi", "agent", "fleet", "tiers.json"),
    });
    deps.tierStore = tierStore;
    const reloadTiers = (): void => {
      deps.tierRegistry = new TierRegistry({
        tiers: mergeTiers(BUILTIN_TIERS, tierStore.read("global"), tierStore.read("project")),
        agents: deps.registry,
      });
    };
    deps.reloadTiers = reloadTiers;
    reloadTiers();  // build the real merged registry (replaces the builtin-only placeholder)

    // SPEC-6-3: workflow journal + registry + runner + fleet tool wiring.
    const workflowJournal = new WorkflowJournal(join(dir, "workflows"));
    wfRegistry = new WorkflowRegistry(discoverWorkflows({
      projectDir: join(ctx.cwd, ".pi", "fleet", "workflows"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "fleet", "workflows"),
      builtinDir: join(new URL(".", import.meta.url).pathname, "workflows", "builtin"),
    }).workflows);
    const workflowRegistry = wfRegistry;
    // SPEC-6-3: production workflow child/lifecycle adapters (Task 5). Replace the inline spawn stub
    // with the adapter factory so workflow-internal parallel calls use the per-workflow ConcurrencyPool
    // + fresh per-child locks (not the foreground singleton), and lifecycle phase spawns share the pool.
    wfSessionAbort = new AbortController();
    const adapters = createWorkflowAdapters({
      registry: deps.registry as unknown as Map<string, unknown>,
      todoSync: deps.todoSync,
      runRegistry: deps.runRegistry,
      backendRegistry: deps.backendRegistry,
      parentModel: deps.parentModel,
      parentCwd: ctx.cwd,
      runLog: deps.runLog,
      tierRegistry: deps.tierRegistry,
      modelRegistry: deps.modelRegistry,
      lifecycleDeps: deps.lifecycleDeps,
      spawnSubagentFn: async (opts) => { const { spawnSubagent } = await import("./engine/spawnSubagent.ts"); return spawnSubagent(opts); },
      runLifecycleFn: async (task, name, lcOpts) => { const { runLifecycle } = await import("./lifecycle/run-lifecycle.ts"); return runLifecycle(task, name, lcOpts); },
    }, { concurrency: 3, signal: wfSessionAbort.signal });
    const wfRunnerDeps: WorkflowRunDeps = {
      spawn: adapters.spawn,
      runLifecycle: adapters.runLifecycle,
      worktree: deps.asyncRunner.worktree,
      tierRegistry: deps.tierRegistry ?? new TierRegistry({ tiers: BUILTIN_TIERS, agents: deps.registry }),
      journal: workflowJournal,
      runRegistry: deps.runRegistry,
      getModelContextWindow: (m: string) => deps.getModelContextWindow?.(m),
      genRunId: () => "wf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      notify: (m: string, l?: "info" | "warning" | "error") => ctx.ui.notify(m, l ?? "info"),
      onCheckpoint: async () => undefined,
      resolveWorkflow: (name: string) => workflowRegistry.get(name) as { sourceText: string; executable: string } | undefined,
    };
    wfStore = new WorkflowRunStore();
    wfController = new WorkflowController({
      registry: workflowRegistry,
      projectDir: join(ctx.cwd, ".pi", "fleet", "workflows"),
      store: wfStore,
      journal: workflowJournal,
      runWorkflow,
      runDepsFactory: () => wfRunnerDeps,
      inbox: resultsInbox,
      genRunId: wfRunnerDeps.genRunId,
      notify: (m: string, l?: "info" | "warning" | "error") => ctx.ui.notify(m, l ?? "info"),
    });
    wfController.hydrate();
    const wfCands = scanWorkflowResumeCandidates(join(dir, "workflows"));
    if (wfCands.length > 0) {
      ctx.ui.notify(`${wfCands.length} interrupted workflow${wfCands.length > 1 ? "s" : ""} — open /fleet Workflows to resume`, "info");
    }
    pi.registerTool(createFleetTool({
      getController: () => {
        if (!wfController) throw new Error("workflow runtime not initialized for this session");
        return wfController;
      },
    }) as never);
  });

  pi.on("session_shutdown", () => {
    if (fleetWidget) { fleetWidget.dispose(); fleetWidget = null; }
    // SPEC-6-3: abort in-flight workflow children via the session-wide adapter signal.
    // Terminal runs are not re-journaled — only non-terminal spawns observe the abort.
    wfSessionAbort?.abort();
  });

  // SPEC-6-3: inject bounded ResultsInbox + workflow-keyword hints into the system prompt without
  // consuming the inbox. renderHint() is read-only; pull() consumes (left to the model's fleet.results).
  pi.on("before_agent_start", async (event) => {
    const hint = resultsInbox.renderHint();
    const kw = workflowKeywordHint(event.prompt) ?? "";
    if (!hint && !kw) return undefined;
    const block = [hint, kw].filter(Boolean).join("\n");
    return { systemPrompt: event.systemPrompt + "\n\n" + block };
  });

  pi.on("resources_discover", (event, ctx) => {
    if (event.reason === "reload") { refresh(ctx); refreshLifecycles(ctx); }
    return undefined;
  });

  pi.registerTool(createSubagentTool(deps) as never);
  // SPEC-5a: fleet.results — the agent pulls completed bg-run results from the inbox (Q6=C).
  pi.registerTool(createFleetResultsTool({ inbox: resultsInbox }) as never);

  pi.registerCommand("fleet", {
    description: "Open the armory-fleet panel (running + recent subagents + agent registry).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("fleet panel is TUI-only; use the subagent tool in non-interactive modes.", "info");
        return;
      }
      await openWorkflowPanelLoop(
        { ...deps, workflowController: wfController!, workflowStore: wfStore!, workflowRegistry: wfRegistry! },
        {
          custom: (factory) => { ctx.ui.custom(factory as never); },
          editor: (initial) => ctx.ui.editor("Edit workflow source", initial) as Promise<string>,
          input: (prompt) => ctx.ui.input(prompt) as Promise<string>,
          confirm: (prompt) => ctx.ui.confirm(prompt, "Proceed?") as Promise<boolean>,
          notify: (m, t) => ctx.ui.notify(m, t ?? "info"),
          sendUserMessage: (text) => { void pi.sendUserMessage(text); },
        },
      );
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
        spawn: withModelFallbackRetry(async (o) => spawnSubagent({
          agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
          mode: "workflow",
            skillsOverride: o.skills, backendOverride: o.backend,
          registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
          backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd,
          tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,  // SPEC-6-1
        }), deps.defaultModelFallback),
      };
      const res = await runLifecycle(parsed.task, lcName, { deps: lifecycleFullDeps, mode: parsed.auto ? "auto" : "checkpointed", onCheckpoint });
      deps.lifecycleRuns.set(res.runId, res);
      ctx.ui.notify(`lifecycle ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
    },
  });

  // SPEC-6-2: gate extensibility — pi doesn't expose registerGate, so we provide a command
  // so other extensions can register custom gates at runtime.
  pi.registerCommand("fleet-register-gate", {
    description: "Register a custom gate on the fleet gate registry (extensibility path).",
    handler: async (_args, ctx) => {
      ctx.ui.notify("fleet-register-gate: custom gates must be registered via the GateRegistry module export (see src/lifecycle/gates/registry.ts).", "info");
    },
  });
}
