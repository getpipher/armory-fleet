// src/panel/fleet-panel.ts
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  matchesKey,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { AgentDef, ThinkingLevel } from "../registry/frontmatter.ts";
import { agentsRow, agentInfo, backendsRow, backendInfo, lifecycleRow, lifecyclePhaseTimeline, scheduleRow } from "./rows.ts";
import { buildFleetItems } from "./fleet-items.ts";
import { runsRow, runTimelineRow } from "./runs-rows.ts";
import { messageBody, toolBody, messageHeader, toolHeader } from "./conversation-rows.ts";
import { buildRunsIndex } from "./runs-index.ts";
import type { RunLog, RunMeta, RunLogEvent, MessageEvent, ToolEvent } from "../runtime/run-log.ts";
import { LiveTimelineState } from "./live-timeline.ts";
import type { Scheduler, Schedule } from "../scheduling/scheduler.ts";
import type { BgRunsStore } from "./bg-runs-store.ts";
import { spawnSubagent, type SpawnResult } from "../engine/spawnSubagent.ts";
import type { Backend, BackendRegistry } from "../backend/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { LifecycleDef, LifecycleRunRecord, CheckpointDecision, PhaseRecord } from "../lifecycle/lifecycle-types.ts";
import type { LifecycleRunDeps, CheckpointFn } from "../lifecycle/run-lifecycle.ts";
import { runLifecycle } from "../lifecycle/run-lifecycle.ts";
import type { TierRegistry } from "../tiers/tier-registry.ts";
import type { TierStore } from "../tiers/tier-store.ts";
import { buildTiersItems, setTierCostCap, setTierModels, setTierContextFloor, addTier, deleteTier } from "./tiers-items.ts";
import { buildWorkflowPanelItems, actionsForWorkflowItem, parseWorkflowPanelKey, type WorkflowPanelItem, type WorkflowPanelAction } from "../workflows/panel/workflows-rows.ts";
import type { WorkflowController } from "../workflows/runtime/controller.ts";
import type { WorkflowRunStore } from "../workflows/runtime/run-store.ts";
import type { WorkflowRegistry } from "../workflows/registry.ts";
import type { WorkflowPanelIntent } from "../workflows/panel-host.ts";

type View = "fleet" | "lifecycle" | "runs" | "agents" | "backends" | "scheduled" | "tiers" | "workflows";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory
  parentModel: { provider: string; id: string };
  parentCwd: string;
  /** #78: fleet-wide default thinking level (settings.json `defaultSubagentThinking`).
   *  Threads to every panel-driven spawn (Run/Resume/Fork + lifecycle-view phases). */
  defaultSubagentThinking?: ThinkingLevel;
  /** SPEC-4: lifecycle registry + active/recent run records + deps to drive checkpoints. */
  lifecycleRegistry: Map<string, LifecycleDef>;
  lifecycleRuns: Map<string, LifecycleRunRecord>;
  lifecycleDeps: Omit<LifecycleRunDeps, "spawn">;
  /** SPEC-5a: scheduler for the scheduled tab. Optional — panel degrades to an empty list when absent. */
  scheduler?: Scheduler;
  /** SPEC-5a: live bg run status rows for the fleet tab. Optional. */
  bgRuns?: BgRunsStore;
  /** SPEC-5b-1: durable per-run conversation log. Optional — Runs tab degrades to empty when absent. */
  runLog?: RunLog;
  /** SPEC-6-1: tier registry for the Tiers view. Optional — panel degrades to empty list when absent. */
  tierRegistry?: TierRegistry;
  /** SPEC-6-1: tier store for inline edits. Optional — Tiers view action keys are no-ops when absent. */
  tierStore?: TierStore;
  /** SPEC-6-1: callback to rebuild the tier registry after a write. */
  reloadTiers?: () => void;
  /** SPEC-6-1: model contextWindow resolver for Runs-tab ctx% (Surface C). Optional — ctx% hidden when absent. */
  getModelContextWindow?: (model: string) => number | undefined;
  /** SPEC-6-3: live workflow controller + store + registry for the Workflows view. */
  workflowController: WorkflowController;
  workflowStore: WorkflowRunStore;
  workflowRegistry: WorkflowRegistry;
  /** SPEC-6-3: panel intent callback for host-only actions (Task 12 wires). */
  onWorkflowIntent?: (intent: { action: string; runId?: string; definitionName?: string }) => void;
}

export interface FleetPanelOpts {
  theme: Theme;
  deps: FleetPanelDeps;
  onDone: (intent?: WorkflowPanelIntent | null) => void;
  onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
}

export class FleetPanel extends Container {
  private readonly theme: Theme;
  private readonly deps: FleetPanelDeps;
  private readonly onDone: (intent?: WorkflowPanelIntent | null) => void;
  private readonly onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
  private view: View = "fleet";
  private list: SelectList;
  private runMode = false;
  private taskInput: Input | null = null;
  private linkInput: Input | null = null;
  private linkPhase: "task" | "link" = "task";
  private infoAgent: AgentDef | null = null;
  private selectedBackend: Backend | null = null;   // SPEC-3: Backends view i:Info
  private selectedLifecycle: LifecycleRunRecord | null = null;   // SPEC-4: Lifecycle view i:Info
  // SPEC-4: Run-lifecycle inline input state
  private lcRunMode = false;
  private lcTaskInput: Input | null = null;
  private lcNameInput: Input | null = null;
  private lcCwdInput: Input | null = null;
  private lcPhase: "task" | "name" | "cwd" = "task";
  // SPEC-4: pending checkpoint (interactive Continue/Revise/Abort)
  private pendingCheckpoint: { phase: PhaseRecord; resolve: (d: CheckpointDecision) => void } | null = null;
  private lcReviseInput: Input | null = null;
  private lcRevising = false;
  // SPEC-5a: scheduled tab — add-schedule inline input state + selected schedule for i:Info
  private schedRunMode = false;
  private schedTaskInput: Input | null = null;
  private schedExprInput: Input | null = null;
  private schedNameInput: Input | null = null;
  private schedPhase: "task" | "expr" | "name" = "task";
  private selectedSchedule: Schedule | null = null;
  // SPEC-5b-1: Runs tab — replay overlay state + resume/fork input state
  private selectedRun: RunMeta | null = null;
  private runTimeline: RunLogEvent[] | null = null;
  private resumeInput: Input | null = null;
  private resumeMode = false;
  // SPEC-5b-4: Steer inline input state (mid-run redirect; mirrors resumeMode/resumeInput).
  private steerInput: Input | null = null;
  private steerMode = false;
  // SPEC-6-1: Tiers view inline-edit state (mirrors steerInput/steerMode).
  private tiersInput: Input | null = null;
  private tiersEditPhase: "models" | "costCap" | "contextFloor" | "add" | null = null;
  private tiersScope: "project" | "global" = "project";
  // SPEC-5b-3: full-message overlay (second level over the 5b-1 timeline) + stored SelectList refs
  // so handleInput can forward keys to the active overlay (Container/TUI routes input only to the
  // focused component = this panel; children receive keys only if we forward them).
  private selectedEventIndex: number | null = null;
  private fullMessageEvent: MessageEvent | ToolEvent | null = null;
  private timelineList: SelectList | null = null;
  private messageBodyList: SelectList | null = null;
  /** SPEC-5a proper-fix: store-change subscriptions — fired by RunRegistry + BgRunsStore
   * so the panel re-renders the moment a (fore- or back-ground) run mutates, without a keypress. */
  private readonly unsubs: (() => void)[] = [];
  private closed = false;   // SPEC-5a proper-fix: guard against double-close calling onDone twice
  // SPEC-6-4: live mode for the timeline overlay (running runs stream; finished runs replay).
  private liveUnsub: (() => void) | null = null;
  private liveState: LiveTimelineState | null = null;

  private renderedTimelineCount(): number {
    return (this.runTimeline ?? []).filter((e) => e.type === "message" || e.type === "tool").length;
  }

  /** SPEC-6-4: release the live subscription (overlay close / different run / panel close). */
  private releaseLiveTimeline(): void {
    this.liveUnsub?.();
    this.liveUnsub = null;
    this.liveState = null;
  }

  /** SPEC-6-4: shared timeline-open (Runs view + gate evidence). Hydrates replay; LIVE when the
   *  run is still running — subscribes to appends and tail-follows via LiveTimelineState. */
  private openRunTimeline(runId: string): void {
    const runLog = this.deps.runLog;
    if (!runLog) return;
    const meta = buildRunsIndex(runLog.dir).find((r) => r.runId === runId) ?? null;
    this.selectedRun = meta;
    this.runTimeline = runLog.replay(runId);
    this.releaseLiveTimeline();
    if (meta?.status === "running") {
      this.liveState = new LiveTimelineState();
      this.liveState.index = Math.max(0, this.renderedTimelineCount() - 1);
      this.liveUnsub = runLog.subscribe((rid, ev) => {
        if (rid !== runId || (ev.type !== "message" && ev.type !== "tool")) return;
        this.runTimeline = [...(this.runTimeline ?? []), ev];
        const idx = this.liveState?.append(this.renderedTimelineCount());
        this.selectedEventIndex = idx ?? null;
        // #85: while the full-message overlay is open, its content comes from the stable
        // fullMessageEvent — rebuilding the panel here (fresh SelectList per append) churns
        // overlay scroll/selection for nothing, and nothing beneath the overlay is visible.
        // Skip the render; closing the overlay triggers the next full render, which picks up
        // every accumulated append. Data above stays current (runTimeline/selectedEventIndex).
        if (!this.fullMessageEvent) this.renderShell();
      });
    }
    this.renderShell();
  }
  // SPEC-6-3: Workflows view — inline Run prompt input state
  private wfRunMode = false;
  private wfPromptInput: Input | null = null;
  private wfRunDefinitionName = "";

  constructor(opts: FleetPanelOpts) {
    super();
    this.theme = opts.theme;
    this.deps = opts.deps;
    this.onDone = opts.onDone;
    this.onNotify = opts.onNotify;

    const accent = (s: string): string => this.theme.fg("accent", s);
    this.addChild(new DynamicBorder(accent));
    this.addChild(new Spacer(1));
    this.list = this.buildList();
    this.renderShell();

    // SPEC-5a proper-fix: subscribe to run-registry + bg-runs mutations → live refresh.
    // Covers both the model-invoked foreground case (spawnSubagent updates runRegistry)
    // and the async/bg case (onProgress mutates BgRunsStore while the parent is idle).
    this.unsubs.push(this.deps.runRegistry.subscribe(() => this.refresh()));
    if (this.deps.bgRuns) this.unsubs.push(this.deps.bgRuns.subscribe(() => this.refresh()));
    // SPEC-6-3: subscribe to workflow store mutations → live Workflows view refresh.
    this.unsubs.push(this.deps.workflowStore.subscribe(() => this.refresh()));
  }

  private buildList(): SelectList {
    const items: SelectItem[] =
      this.view === "fleet"
        ? buildFleetItems({ runRegistry: this.deps.runRegistry, bgRuns: this.deps.bgRuns })
        : this.view === "lifecycle"
          ? [...this.deps.lifecycleRuns.values()].map((l: LifecycleRunRecord) => ({ value: l.runId, label: lifecycleRow(l) }))
          : this.view === "runs"
            ? buildRunsIndex(this.deps.runLog?.dir ?? "").map((r: RunMeta) => ({ value: r.runId, label: runsRow(r, this.deps.getModelContextWindow) }))
            : this.view === "agents"
              ? [...this.deps.registry.values()].map((a: AgentDef) => ({ value: a.name, label: agentsRow(a) }))
            : this.view === "scheduled"
              ? (this.deps.scheduler?.list() ?? []).map((s: Schedule) => ({ value: s.id, label: scheduleRow(s) }))
            : this.view === "tiers"
              ? (this.deps.tierRegistry ? buildTiersItems({ tierRegistry: this.deps.tierRegistry, runRegistry: this.deps.runRegistry }) : [])
            : this.view === "workflows"
              ? buildWorkflowPanelItems({ definitions: this.deps.workflowRegistry.list(), runs: this.deps.workflowStore.values() })
            : this.deps.backendRegistry.list().map((b: Backend) => ({ value: b.id, label: backendsRow(b) }));
    const fresh = new SelectList(items, 12, {
      selectedPrefix: (s: string) => this.theme.fg("accent", s),
      selectedText: (s: string) => this.theme.fg("accent", s),
      description: (s: string) => this.theme.fg("muted", s),
      scrollInfo: (s: string) => this.theme.fg("dim", s),
      noMatch: (s: string) => this.theme.fg("warning", s),
    });
    fresh.onSelect = (item: SelectItem) => this.onSelect(item.value);
    fresh.onCancel = () => this.close();
    return fresh;
  }

  /** SPEC-5a proper-fix: re-pull from the run-registry + bg-runs stores and re-render.
   * Called by the store-change subscriptions (constructor) on every mutation, so the
   * fleet tab reflects completion/status changes without a keypress. Safe to call
   * mid-overlay: renderShell preserves the active overlay (input/info/checkpoint). */
  private refresh(): void {
    this.list = this.buildList();
    this.renderShell();
  }

  /** SPEC-5a proper-fix: tear down store subscriptions then close the panel.
   * Every exit path routes here so listeners never leak past the panel's lifetime.
   * Idempotent — safe to call multiple times (esc + q + pi teardown). */
  private close(intent?: WorkflowPanelIntent | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    // SPEC-6-4: the live timeline subscription dies with the panel.
    this.releaseLiveTimeline();
    this.onDone(intent ?? null);
  }

  private renderShell(): void {
    const keep = this.children.slice(0, 2);
    this.children.length = 0;
    this.children.push(...keep);
    const accent = (s: string): string => this.theme.fg("accent", s);
        const tabs = (["fleet", "lifecycle", "runs", "agents", "backends", "scheduled", "tiers", "workflows"] as View[])
      .map((v) => (v === this.view ? this.theme.fg("accent", this.theme.bold(`[${v}]`)) : this.theme.fg("dim", v)))
      .join("  ");
    this.addChild(new Text(accent(this.theme.bold("  FLEET")) + "  " + tabs, 0, 0));
    this.addChild(new Spacer(1));

    if (this.runMode && (this.taskInput || this.linkInput)) {
      const prompt = this.linkPhase === "task" ? "  task> " : "  link to todo? (id or blank to create fleet task): ";
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.linkPhase === "task" ? this.taskInput! : this.linkInput!);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.infoAgent) {
      // i:Info read-only detail pane (agents view)
      for (const line of agentInfo(this.infoAgent).split("\n")) {
        this.addChild(new Text(this.theme.fg("text", line), 0, 0));
      }
    } else if (this.selectedBackend) {
      // SPEC-3: i:Info detail pane (backends view)
      this.addChild(new Text(this.theme.fg("dim", "  ── backend info ──"), 0, 0));
      for (const line of backendInfo(this.selectedBackend).split("\n")) {
        this.addChild(new Text(this.theme.fg("text", line), 0, 0));
      }
      this.addChild(new Text(this.theme.fg("dim", "  esc:Back"), 0, 0));
    } else if (this.selectedLifecycle) {
      // SPEC-4: i:Info detail pane (lifecycle view) — phase timeline
      this.addChild(new Text(this.theme.fg("dim", "  ── lifecycle phases ──"), 0, 0));
      for (const line of lifecyclePhaseTimeline(this.selectedLifecycle).split("\n")) {
        this.addChild(new Text(this.theme.fg("text", line), 0, 0));
      }
      this.addChild(new Text(this.theme.fg("dim", "  esc:Back"), 0, 0));
    } else if (this.selectedSchedule) {
      // SPEC-5a: i:Info detail pane (scheduled view)
      this.addChild(new Text(this.theme.fg("dim", "  ── schedule info ──"), 0, 0));
      const s = this.selectedSchedule;
      for (const line of [
        `id: ${s.id}`,
        `expression: ${s.expression}`,
        `lifecycle: ${s.lifecycle}`,
        `task: "${s.task}"`,
        `paused: ${s.paused}`,
        `nextFire: ${s.nextFire?.toLocaleString() ?? "(none)"}`,
      ]) this.addChild(new Text(this.theme.fg("text", line), 0, 0));
      this.addChild(new Text(this.theme.fg("dim", "  esc:Back"), 0, 0));
    } else if (this.fullMessageEvent) {
      // SPEC-5b-3: full-message overlay (top of the stack). Header + scrollable wrapped body.
      const e = this.fullMessageEvent;
      const isMsg = e.type === "message";
      const header = isMsg ? messageHeader(e) : toolHeader(e);
      this.addChild(new Text(this.theme.fg("dim", `  ${header}`), 0, 0));
      // Width: the panel renders at the terminal width pi gives ctx.ui.custom. Rows are pre-baked
      // into SelectItem.label, so wrap now. Fall back to 80 if the live width isn't reachable here
      // — the list still scrolls; a resize re-wraps on the next renderShell().
      const width = 80;
      const bodyLines = isMsg ? messageBody(e, width) : toolBody(e, width);
      const body = new SelectList(
        bodyLines.map((line) => ({ value: "", label: line })),
        Math.min(bodyLines.length, 12),
        {
          selectedPrefix: (s: string) => this.theme.fg("accent", s),
          selectedText: (s: string) => this.theme.fg("accent", s),
          description: (s: string) => this.theme.fg("muted", s),
          scrollInfo: (s: string) => this.theme.fg("dim", s),
          noMatch: (s: string) => this.theme.fg("warning", s),
        },
      );
      // esc → back to timeline. Leave onSelect unset so Enter (tui.select.confirm) is swallowed
      // silently by SelectList.handleInput — a text line has nothing to drill into.
      // Do NOT clear selectedEventIndex here: it survives to drive the timeline cursor restore.
      body.onCancel = () => {
        this.fullMessageEvent = null;
        this.messageBodyList = null;
        this.renderShell();
      };
      this.messageBodyList = body;
      this.addChild(body);
      this.addChild(new Text(this.theme.fg("dim", "  esc:Back"), 0, 0));
    } else if (this.selectedRun) {
      // SPEC-5b-1/5b-3: Runs tab — per-turn timeline replay. SPEC-5b-3 makes the list interactive
      // (arrows scroll, enter opens full-message overlay, esc back to Runs list) by forwarding input
      // to the stored SelectList (see handleInput) — v0.6.0 swallowed all non-escape keys.
      this.addChild(new Text(this.theme.fg("dim", `  ── run ${this.selectedRun.runId} — timeline ──`), 0, 0));
      const events = (this.runTimeline ?? []).filter((e) => e.type === "message" || e.type === "tool") as Array<MessageEvent | ToolEvent>;
      if (events.length === 0) {
        this.addChild(new Text(this.theme.fg("dim", "  (no conversation events)"), 0, 0));
      } else {
        const tl = new SelectList(
          events.map((e, idx) => ({ value: String(idx), label: runTimelineRow(e as never) })),
          Math.min(events.length, 12),
          {
            selectedPrefix: (s: string) => this.theme.fg("accent", s),
            selectedText: (s: string) => this.theme.fg("accent", s),
            description: (s: string) => this.theme.fg("muted", s),
            scrollInfo: (s: string) => this.theme.fg("dim", s),
            noMatch: (s: string) => this.theme.fg("warning", s),
          },
        );
        // SPEC-5b-3: enter on a timeline row → open the full-message overlay for that event.
        tl.onSelect = (item) => {
          const idx = Number(item.value);
          const ev = events[idx];
          if (!ev) { this.onNotify("event no longer available", "warning"); return; }
          this.selectedEventIndex = idx;
          this.fullMessageEvent = ev;
          this.renderShell();
        };
        // SPEC-5b-3: restore the cursor to the row we were viewing (one-shot, then clear the token).
        if (this.selectedEventIndex != null) {
          tl.setSelectedIndex(this.selectedEventIndex);
          this.selectedEventIndex = null;
        }
        // esc → back to Runs list (replaces the v0.6.0 panel-level escape catch).
        tl.onCancel = () => { this.releaseLiveTimeline(); this.selectedRun = null; this.runTimeline = null; this.timelineList = null; this.renderShell(); };
        this.timelineList = tl;
        this.addChild(tl);
      }
      this.addChild(new Text(this.theme.fg("dim", "  enter:Full-message  esc:Back"), 0, 0));
    } else if (this.wfRunMode && this.wfPromptInput) {
      // SPEC-6-3: Workflows tab — inline Run prompt input.
      this.addChild(new Text(this.theme.fg("accent", `  run ${this.wfRunDefinitionName}> `), 0, 0));
      this.addChild(this.wfPromptInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit (blank=direct run) • esc cancel"), 0, 0));
    } else if (this.steerMode && this.steerInput) {
      // SPEC-5b-4: Fleet tab — mid-run steer input.
      this.addChild(new Text(this.theme.fg("accent", "  steer> "), 0, 0));
      this.addChild(this.steerInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.tiersEditPhase && this.tiersInput) {
      // SPEC-6-1: Tiers tab — inline edit input.
      const sel = this.list.getSelectedItem();
      const name = sel?.value ?? "";
      const prompt = this.tiersEditPhase === "add" ? "  new tier name> "
        : this.tiersEditPhase === "models" ? `  models for ${name}> `
        : this.tiersEditPhase === "costCap" ? `  costCap for ${name}> `
        : `  contextFloor for ${name}> `;
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.tiersInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.resumeMode && this.resumeInput) {
      // SPEC-5b-1: Runs tab — resume follow-up input.
      this.addChild(new Text(this.theme.fg("accent", "  follow-up> "), 0, 0));
      this.addChild(this.resumeInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.schedRunMode && (this.schedTaskInput || this.schedExprInput || this.schedNameInput)) {
      const prompt = this.schedPhase === "task" ? "  task> " : this.schedPhase === "expr" ? "  schedule (cron | interval | one-shot ISO)> " : "  lifecycle (blank=default)> ";
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.schedPhase === "task" ? this.schedTaskInput! : this.schedPhase === "expr" ? this.schedExprInput! : this.schedNameInput!);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.lcRunMode && (this.lcTaskInput || this.lcNameInput || this.lcCwdInput)) {
      const prompt = this.lcPhase === "task" ? "  task> " : this.lcPhase === "name" ? "  lifecycle name (blank=default)> " : "  cwd (blank=session cwd)> ";
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.lcPhase === "task" ? this.lcTaskInput! : this.lcPhase === "name" ? this.lcNameInput! : this.lcCwdInput!);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else if (this.pendingCheckpoint && !this.lcRevising) {
      const pc = this.pendingCheckpoint;
      this.addChild(new Text(this.theme.fg("dim", `  ── checkpoint: phase '${pc.phase.name}' (${pc.phase.status}) ──`), 0, 0));
      this.addChild(new Text(this.theme.fg("text", `  ${pc.phase.summary.slice(0, 200)}`), 0, 0));
      this.addChild(new Text(this.theme.fg("dim", "  c:Continue  v:Revise  a:Abort"), 0, 0));
    } else if (this.lcRevising && this.lcReviseInput) {
      this.addChild(new Text(this.theme.fg("accent", "  revise feedback> "), 0, 0));
      this.addChild(this.lcReviseInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else {
      this.addChild(this.list);
    }

    this.addChild(new Spacer(1));
    const hint =
      this.fullMessageEvent
        ? "  esc:Back"
        : this.infoAgent || this.selectedBackend || this.selectedLifecycle || this.selectedSchedule || this.selectedRun
          ? (this.selectedRun ? "  enter:Full-message  esc:Back" : this.selectedLifecycle ? "  v:View-evidence  g:Re-run-gate  esc:Back" : "  esc:Back")
        : this.pendingCheckpoint
          ? "  c:Continue  v:Revise  a:Abort"
          : this.lcRevising
            ? "  enter:Submit-feedback  esc:Cancel"
            : this.view === "fleet"
              ? "  r:Run-new  s:Steer  x:Stop  o:Open-todo  tab:Lifecycle  q:Quit"
              : this.view === "lifecycle"
                ? "  r:Run-lifecycle  i:Info  tab:Runs  q:Quit"
                : this.view === "runs"
                  ? "  enter:Replay  r:Resume  f:Fork  tab:Agents  q:Quit"
                  : this.view === "agents"
                  ? "  r:Run  e:Edit  i:Info  d:Reload  tab:Backends  q:Quit"
                  : this.view === "scheduled"
                    ? "  a:Add  p:Pause/resume  d:Delete  i:Info  tab:Tiers  q:Quit"
                  : this.view === "tiers"
                    ? "  m:Models  c:costCap  f:contextFloor  a:Add  d:Delete  g:scope  tab:Workflows  q:Quit"
                  : this.view === "workflows"
                    ? "  r:Run  e:Edit-and-resume  o:Open  p:Pause  u:Resume  x:Stop  s:Save-as  v:View-result  tab:Fleet  q:Quit"
                  : "  r:Refresh  i:Info  tab:Fleet  q:Quit";
    this.addChild(new Text(this.theme.fg("dim", hint), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(accent));
    this.invalidate();
  }

  private onSelect(value: string): void {
    if (this.view === "agents") this.startRun(value);
    // Fleet view: selection is informational; actions are the `r`/`s`/`o` keys.
    void value;
  }

  private startRun(agentName: string): void {
    this.linkPhase = "task";
    this.taskInput = new Input();
    this.taskInput.onSubmit = (task: string) => {
      if (!task.trim()) { this.cancelRun(); return; }
      this.linkPhase = "link";
      this.linkInput = new Input();
      this.linkInput.onSubmit = (todoIdRaw: string) => {
        void this.executeRun(agentName, task.trim(), todoIdRaw.trim() || undefined);
      };
      this.renderShell();
    };
    this.runMode = true;
    this.renderShell();
  }

  private async executeRun(agent: string, task: string, todoId?: string): Promise<void> {
    this.runMode = false;
    this.taskInput = null;
    this.linkInput = null;
    this.renderShell();
    const res: SpawnResult = await spawnSubagent({
      agent, task, todoId, track: true,
      registry: this.deps.registry, todoSync: this.deps.todoSync,
      runRegistry: this.deps.runRegistry, lock: this.deps.lock,
      backendRegistry: this.deps.backendRegistry,
      parentModel: this.deps.parentModel, parentCwd: this.deps.parentCwd,
      runLog: this.deps.runLog,
      defaultThinkingLevel: this.deps.defaultSubagentThinking,
      // live Fleet row during the run (SPEC-1 §4c) — re-render on each turn_end
      onEvent: (e) => {
        if (e.type === "turn_end") {
          this.list = this.buildList();
          this.renderShell();
        }
      },
    });
    this.list = this.buildList();
    this.renderShell();
    this.onNotify(
      `${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`,
      res.status === "completed" ? "info" : "warning",
    );
  }

  private cancelRun(): void {
    this.runMode = false;
    this.taskInput = null;
    this.linkInput = null;
    this.renderShell();
  }

  private switchView(): void {
    this.view = this.view === "fleet" ? "lifecycle"
      : this.view === "lifecycle" ? "runs"
      : this.view === "runs" ? "agents"
      : this.view === "agents" ? "backends"
      : this.view === "backends" ? "scheduled" : this.view === "scheduled" ? "tiers" : this.view === "tiers" ? "workflows" : "fleet";
    this.selectedBackend = null;
    this.selectedLifecycle = null;
    this.selectedSchedule = null;
    this.selectedRun = null;
    this.runTimeline = null;
    this.selectedEventIndex = null;
    this.fullMessageEvent = null;
    this.timelineList = null;
    this.messageBodyList = null;
    this.steerMode = false;       // SPEC-5b-4: drop any in-flight steer input on tab switch
    this.steerInput = null;
    this.tiersEditPhase = null;   // SPEC-6-1: drop any in-flight tiers edit on tab switch
    this.tiersInput = null;
    this.list = this.buildList();
    this.renderShell();
  }

  handleInput(data: string): void {
    // Escape policy (#63): every modal branch below intercepts Escape BEFORE the active Input
    // sees it, so pi-tui's Input.onEscape never fires in this panel — Escape always cancels
    // the active flow. Defaults are accepted via Enter-on-blank ("blank=default" prompts).
    // Caveat: ctrl+c also matches pi-tui's tui.select.cancel but is NOT intercepted here —
    // it forwards to the Input, which ignores control characters (silent no-op). An onEscape
    // callback re-added later would fire on ctrl+c but never on Escape — do not re-add.
    if (this.infoAgent) {
      if (matchesKey(data, "escape")) { this.infoAgent = null; this.renderShell(); }
      return;
    }
    if (this.selectedBackend) {
      if (matchesKey(data, "escape")) { this.selectedBackend = null; this.renderShell(); }
      return;
    }
    if (this.selectedLifecycle) {
      if (matchesKey(data, "escape")) { this.selectedLifecycle = null; this.renderShell(); return; }
      // SPEC-6-2: v:View-evidence — open the conversation viewer on the first agent gate's runId.
      if (matchesKey(data, "v")) {
        const agentGate = this.selectedLifecycle.phases
          .flatMap((p) => p.gateResults ?? [])
          .find((gr) => gr.runId);
        if (agentGate?.runId && this.deps.runLog) {
          this.openRunTimeline(agentGate.runId);
          this.selectedLifecycle = null;
          this.view = "runs";
          this.renderShell();
        } else if (agentGate) {
          this.onNotify(`Gate '${agentGate.gate}' evidence: ${agentGate.evidence.slice(0, 200)}`, "info");
        } else {
          const predGate = this.selectedLifecycle.phases
            .flatMap((p) => p.gateResults ?? [])
            .find((gr) => !gr.passed && gr.evidence);
          if (predGate) {
            this.onNotify(`Gate '${predGate.gate}' evidence: ${predGate.evidence.slice(0, 200)}`, "info");
          } else {
            this.onNotify("No gate evidence available for this lifecycle.", "info");
          }
        }
        return;
      }
      // SPEC-6-2: g:Re-run-gate — requires the GateCtx which the runtime holds, not the panel.
      // Full re-run from the panel is a post-v0.11.0 enhancement (the panel doesn't have the GateCtx).
      if (matchesKey(data, "g")) {
        if (this.selectedLifecycle.status === "checkpoint") {
          this.onNotify("Gate re-run from the panel is not yet supported — use the fleet tool or revise at the checkpoint to re-trigger gates.", "info");
        } else {
          this.onNotify("Gate re-run requires a checkpointed lifecycle (current status: " + this.selectedLifecycle.status + ").", "warning");
        }
        return;
      }
      return;
    }
    if (this.selectedSchedule) {
      if (matchesKey(data, "escape")) { this.selectedSchedule = null; this.renderShell(); }
      return;
    }
    if (this.fullMessageEvent) {
      // SPEC-5b-3: full-message overlay — forward to the body SelectList (arrows scroll; esc via
      // onCancel back to timeline; enter is a no-op). Replaces the v0.6.0 swallow-all pattern.
      this.messageBodyList?.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.selectedRun) {
      // SPEC-6-4: in live mode the panel owns up/down (tail-follow cursor) — intercepted before
      // the SelectList forward; everything else forwards as before. Finished runs: replay path.
      if (this.liveState && (matchesKey(data, "up") || matchesKey(data, "down"))) {
        const total = this.renderedTimelineCount();
        const key = matchesKey(data, "up") ? "up" : "down";
        if (this.liveState.onKey(key, total)) {
          this.selectedEventIndex = this.liveState.index;
          this.renderShell();
        }
        return;
      }
      this.timelineList?.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.wfRunMode && this.wfPromptInput) {
      if (matchesKey(data, "escape")) { this.cancelWorkflowRun(); return; }
      this.wfPromptInput.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.steerMode && this.steerInput) {
      if (matchesKey(data, "escape")) { this.cancelSteer(); return; }
      this.steerInput.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.tiersEditPhase && this.tiersInput) {
      if (matchesKey(data, "escape")) { this.cancelTiersEdit(); return; }
      this.tiersInput.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.resumeMode && this.resumeInput) {
      if (matchesKey(data, "escape")) { this.cancelResume(); return; }
      this.resumeInput.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.schedRunMode && (this.schedTaskInput || this.schedExprInput || this.schedNameInput)) {
      if (matchesKey(data, "escape")) { this.cancelScheduleAdd(); return; }
      (this.schedPhase === "task" ? this.schedTaskInput! : this.schedPhase === "expr" ? this.schedExprInput! : this.schedNameInput!).handleInput(data);
      this.invalidate();
      return;
    }
    if (this.lcRunMode && (this.lcTaskInput || this.lcNameInput || this.lcCwdInput)) {
      if (matchesKey(data, "escape")) { this.cancelLifecycleRun(); return; }
      (this.lcPhase === "task" ? this.lcTaskInput! : this.lcPhase === "name" ? this.lcNameInput! : this.lcCwdInput!).handleInput(data);
      this.invalidate();
      return;
    }
    if (this.runMode && (this.taskInput || this.linkInput)) {
      if (matchesKey(data, "escape")) { this.cancelRun(); return; }
      (this.linkPhase === "task" ? this.taskInput! : this.linkInput!).handleInput(data);
      this.invalidate();
      return;
    }
    if (matchesKey(data, "escape")) {
      // SPEC-4: if a lifecycle checkpoint is pending, resolve it as abort so runLifecycle
      // doesn't hang + the lifecycle TODO is reverted (not orphaned) when the panel closes.
      if (this.pendingCheckpoint) {
        this.pendingCheckpoint.resolve({ action: "abort" });
        this.pendingCheckpoint = null;
      }
      this.close();
      return;
    }
    if (matchesKey(data, "tab")) { this.switchView(); return; }
    if (matchesKey(data, "q")) { this.close(); return; }
    if (matchesKey(data, "r") && this.view === "agents") {
      const sel = this.list.getSelectedItem();
      if (sel) this.startRun(sel.value);
      return;
    }
    if (matchesKey(data, "i") && this.view === "agents") {
      const sel = this.list.getSelectedItem();
      if (sel) { this.infoAgent = this.deps.registry.get(sel.value) ?? null; this.renderShell(); }
      return;
    }
    if (matchesKey(data, "i") && this.view === "backends") {
      const sel = this.list.getSelectedItem();
      if (sel) { this.selectedBackend = this.deps.backendRegistry.list().find((x) => x.id === sel.value) ?? null; this.renderShell(); }
      return;
    }
    if (matchesKey(data, "r") && this.view === "backends") {
      this.onNotify("Backends reflect init-time detection; restart pi to re-detect.", "info");
      this.renderShell();
      return;
    }
    // SPEC-5b-4: Fleet view — s:Steer (pi-only) + x:Stop (any backend) on the selected running row.
    if (this.view === "fleet") {
      if (matchesKey(data, "s")) { this.startSteer(); return; }
      if (matchesKey(data, "x")) { this.executeStop(); return; }
    }
    // SPEC-5b-1: Runs view — enter/i:Replay  R:Resume  F:Fork
    if (this.view === "runs" && this.deps.runLog) {
      if (matchesKey(data, "enter") || matchesKey(data, "i")) {
        const sel = this.list.getSelectedItem();
        if (sel) {
          this.openRunTimeline(sel.value);
        }
        return;
      }
      if (matchesKey(data, "r")) { this.startResume(); return; }
      if (matchesKey(data, "f")) { this.startFork(); return; }
    }
    // SPEC-4: Lifecycle view — i:Info + r:Run-lifecycle
    if (matchesKey(data, "i") && this.view === "lifecycle") {
      const sel = this.list.getSelectedItem();
      if (sel) { this.selectedLifecycle = this.deps.lifecycleRuns.get(sel.value) ?? null; this.renderShell(); }
      return;
    }
    if (matchesKey(data, "r") && this.view === "lifecycle") {
      this.startLifecycleRun();
      return;
    }
    // SPEC-5a: scheduled view — a:Add p:Pause/resume d:Delete i:Info
    if (this.view === "scheduled" && this.deps.scheduler) {
      if (matchesKey(data, "a")) { this.startScheduleAdd(); return; }
      if (matchesKey(data, "i")) {
        const sel = this.list.getSelectedItem();
        if (sel) { this.selectedSchedule = this.deps.scheduler.list().find((x) => x.id === sel.value) ?? null; this.renderShell(); }
        return;
      }
      if (matchesKey(data, "p")) {
        const sel = this.list.getSelectedItem();
        if (sel) {
          const s = this.deps.scheduler.list().find((x) => x.id === sel.value);
          if (s) { s.paused ? this.deps.scheduler.resume(sel.value) : this.deps.scheduler.pause(sel.value); this.list = this.buildList(); this.renderShell(); }
        }
        return;
      }
      if (matchesKey(data, "d")) {
        const sel = this.list.getSelectedItem();
        if (sel) { this.deps.scheduler.delete(sel.value); this.list = this.buildList(); this.renderShell(); }
        return;
      }
    }
    // SPEC-6-1: Tiers view — m:Models c:costCap f:contextFloor a:Add d:Delete g:scope
    if (this.view === "tiers" && this.deps.tierStore && this.deps.tierRegistry) {
      if (matchesKey(data, "m")) { this.startTiersEdit("models"); return; }
      if (matchesKey(data, "c")) { this.startTiersEdit("costCap"); return; }
      if (matchesKey(data, "f")) { this.startTiersEdit("contextFloor"); return; }
      if (matchesKey(data, "a")) { this.startTiersEdit("add"); return; }
      if (matchesKey(data, "d")) { this.executeTiersDelete(); return; }
      if (matchesKey(data, "g")) {
        this.tiersScope = this.tiersScope === "project" ? "global" : "project";
        this.onNotify(`tiers scope: ${this.tiersScope}`, "info");
        this.renderShell();
        return;
      }
    }
    // SPEC-6-3: Workflows view — direct p/u/x controls + host-only intent completion
    if (this.view === "workflows") {
      // #27: classify the key FIRST. Non-action keys (Down/Up/PageUp/PageDown) are forwarded
      // to the list BEFORE the sel check, so nav still works when no row is selected (empty-list
      // edge case the reviewer flagged — the prior `if (!sel) return` at the top swallowed nav
      // keys the same way the original `if (!action) return` did).
      const keyAction: Record<string, WorkflowPanelAction> = {
        r: "run", e: "edit-resume", o: "open", p: "pause", u: "resume", x: "stop", s: "save", v: "view-result", c: "respond",
      }
      const action = keyAction[data]
      if (!action) {
        // Not a workflow action key — forward to the list so Down/Up/PageUp/PageDown move the
        // selection cursor (#27). Without this, every non-action key was swallowed here and the
        // bottom-of-handleInput `this.list.handleInput(data)` was never reached for Workflows,
        // so the → cursor could never move off the first row (blocking all run-row actions).
        this.list.handleInput(data)
        this.invalidate()
        return
      }
      const sel = this.list.getSelectedItem()
      if (!sel) return  // an action key was pressed but there's no row to act on
      const parsed = parseWorkflowPanelKey(sel.value)
      const item: WorkflowPanelItem = parsed.kind === "definition"
        ? { kind: "definition", definition: this.deps.workflowRegistry.get(parsed.name) ?? { name: parsed.name, description: "", phases: [], sourceText: "", body: "", executable: "", source: "builtin", filePath: "" } }
        : { kind: "run", run: this.deps.workflowStore.get(parsed.runId) ?? { runId: parsed.runId, name: parsed.runId, script: "", mode: "auto", status: "completed", startedAt: 0, currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0 } }
      const available = actionsForWorkflowItem(item)

      if (!available.includes(action)) {
        this.onNotify(`action '${action}' not available for this item`, "warning")
        return
      }

      // Direct controls (no panel close)
      if (action === "pause") {
        if (parsed.kind === "run") this.deps.workflowController.pause(parsed.runId)
        return
      }
      if (action === "resume") {
        if (parsed.kind === "run") {
          void this.deps.workflowController.resume(parsed.runId).then(() => {
            this.refresh()
          }).catch((e: unknown) => {
            this.onNotify(`resume failed: ${(e as Error).message}`, "error")
          })
        }
        return
      }
      if (action === "stop") {
        if (parsed.kind === "run") {
          void this.deps.workflowController.stop(parsed.runId).then(() => {
            this.refresh()
          }).catch((e: unknown) => {
            this.onNotify(`stop failed: ${(e as Error).message}`, "error")
          })
        }
        return
      }

      // Run action: inline prompt input for definitions
      if (action === "run" && parsed.kind === "definition") {
        this.startWorkflowRun(parsed.name)
        return
      }

      // Host-only actions: close panel with intent (Task 12 host loop handles them)
      if (action === "run" && parsed.kind === "run") {
        this.close({ action: "run", definitionName: parsed.runId, prompt: "" })
        return
      }
      if (action === "edit-resume") {
        if (parsed.kind === "run") this.close({ action: "edit-resume", runId: parsed.runId })
        return
      }
      if (action === "open") {
        if (parsed.kind === "definition") {
          this.close({ action: "open-definition", name: parsed.name })
        } else {
          const run = this.deps.workflowStore.get(parsed.runId)
          const childId = run?.childRunIds[0]
          if (childId) {
            this.close({ action: "open-child", runId: parsed.runId, childRunId: childId })
          } else {
            this.onNotify(`run '${parsed.runId}' has no child runs to open`, "info")
          }
        }
        return
      }
      if (action === "save") {
        if (parsed.kind === "run") this.close({ action: "save", runId: parsed.runId })
        return
      }
      if (action === "view-result") {
        if (parsed.kind === "run") this.close({ action: "view-result", runId: parsed.runId })
        return
      }
      if (action === "respond") {
        if (parsed.kind === "run") this.close({ action: "respond", runId: parsed.runId })
        return
      }
      return
    }
    // SPEC-4: pending checkpoint keys (c/v/a)
    if (this.pendingCheckpoint && !this.lcRevising) {
      if (matchesKey(data, "c")) { this.pendingCheckpoint.resolve({ action: "continue" }); this.pendingCheckpoint = null; this.renderShell(); return; }
      if (matchesKey(data, "a")) { this.pendingCheckpoint!.resolve({ action: "abort" }); this.pendingCheckpoint = null; this.renderShell(); return; }
      if (matchesKey(data, "v")) {
        this.lcRevising = true;
        this.lcReviseInput = new Input();
        this.lcReviseInput.onSubmit = (fb: string) => {
          this.lcRevising = false;
          this.lcReviseInput = null;
          this.pendingCheckpoint!.resolve({ action: "revise", feedback: fb });
          this.pendingCheckpoint = null;
          this.renderShell();
        };
        this.renderShell();
        return;
      }
    }
    if (this.lcRevising && this.lcReviseInput) {
      // Escape never reaches here — the panel-level intercept above resolves the pending
      // checkpoint as abort + closes the panel first (#63). Only printable input forwards.
      this.lcReviseInput.handleInput(data);
      this.invalidate();
      return;
    }
    this.list.handleInput(data);
    this.invalidate();
  }

  /** SPEC-5a: open the Add-schedule inline inputs (task → expression → lifecycle name → register). */
  private startScheduleAdd(): void {
    this.schedPhase = "task";
    this.schedTaskInput = new Input();
    this.schedTaskInput.onSubmit = (task: string) => {
      if (!task.trim()) { this.cancelScheduleAdd(); return; }
      this.schedPhase = "expr";
      this.schedExprInput = new Input();
      this.schedExprInput.onSubmit = (expr: string) => {
        if (!expr.trim()) { this.cancelScheduleAdd(); return; }
        this.schedPhase = "name";
        this.schedNameInput = new Input();
        this.schedNameInput.onSubmit = (name: string) => {
          const lcName = name.trim() || "default";
          this.executeScheduleAdd(task.trim(), expr.trim(), lcName);
        };
        this.renderShell();
      };
      this.renderShell();
    };
    this.schedRunMode = true;
    this.renderShell();
  }

  private cancelScheduleAdd(): void {
    this.schedRunMode = false;
    this.schedTaskInput = null;
    this.schedExprInput = null;
    this.schedNameInput = null;
    this.renderShell();
  }

  private executeScheduleAdd(task: string, expression: string, lifecycleName: string): void {
    this.schedRunMode = false;
    this.schedTaskInput = null;
    this.schedExprInput = null;
    this.schedNameInput = null;
    if (!this.deps.scheduler) { this.onNotify("scheduling not configured", "error"); this.renderShell(); return; }
    try {
      const id = this.deps.scheduler.register({ task, expression, lifecycle: lifecycleName, auto: true });
      this.list = this.buildList();
      this.renderShell();
      const entry = this.deps.scheduler.list().find((s) => s.id === id);
      this.onNotify(`scheduled: ${id} · next fire: ${entry?.nextFire?.toLocaleString() ?? "(paused)"}`, "info");
    } catch (e) {
      this.onNotify(`schedule register failed: ${(e as Error).message}`, "error");
    }
    this.renderShell();
  }

  /** SPEC-5b-1: Resume — rehydrate the prior session (same agent sessionKey) + a follow-up. */
  private startResume(): void {
    const sel = this.list.getSelectedItem();
    if (!sel) return;
    const run = buildRunsIndex(this.deps.runLog!.dir).find((r) => r.runId === sel.value);
    if (!run) return;
    if (!run.backendSessionId) { this.onNotify("no resumable session for this run", "warning"); return; }
    if (run.status === "running") { this.onNotify("run still running; stop it first", "warning"); return; }
    this.resumeInput = new Input();
    this.resumeInput.onSubmit = (followUp: string) => {
      if (!followUp.trim()) { this.cancelResume(); return; }
      void this.executeResume(run, followUp.trim());
    };
    this.resumeMode = true;
    this.renderShell();
  }

  private cancelResume(): void {
    this.resumeMode = false;
    this.resumeInput = null;
    this.renderShell();
  }

  /** SPEC-5b-4: Steer — open the inline "steer> " input for the selected running row (pi-only). */
  private startSteer(): void {
    const sel = this.list.getSelectedItem();
    if (!sel) return;
    const run = this.deps.runRegistry.get(sel.value);
    if (!run || run.status !== "running") { this.onNotify("run already finished", "warning"); return; }
    if (!run.session) { this.onNotify("run already finished", "warning"); return; }
    if (!run.session.supportsSteer) { this.onNotify("steer not supported on claude backend", "warning"); return; }
    this.steerInput = new Input();
    this.steerInput.onSubmit = (text: string) => {
      if (!text.trim()) { this.cancelSteer(); return; }
      void this.executeSteer(run.runId, text.trim());
    };
    this.steerMode = true;
    this.renderShell();
  }

  private cancelSteer(): void {
    this.steerMode = false;
    this.steerInput = null;
    this.renderShell();
  }

  private async executeSteer(runId: string, text: string): Promise<void> {
    // Re-check: the run may have finished between pressing s and submitting.
    const run = this.deps.runRegistry.get(runId);
    if (!run || !run.session) { this.onNotify("run already finished", "warning"); this.cancelSteer(); return; }
    if (!run.session.supportsSteer) { this.onNotify("steer not supported on claude backend", "warning"); this.cancelSteer(); return; }
    this.steerMode = false;
    this.steerInput = null;
    this.renderShell();
    try {
      await run.session.steer(text);
      this.onNotify("steer queued; lands after current tool calls", "info");
    } catch (e) {
      this.onNotify(`steer failed: ${(e as Error).message}`, "error");
    }
  }

  /** SPEC-5b-4: Stop — abort the selected running row (any backend). */
  private executeStop(): void {
    const sel = this.list.getSelectedItem();
    if (!sel) return;
    const run = this.deps.runRegistry.get(sel.value);
    if (!run || run.status !== "running") { this.onNotify("run already finished", "warning"); return; }
    if (!run.session) { this.onNotify("run already finished", "warning"); return; }
    void (async () => {
      try {
        await run.session!.abort();
        this.onNotify("run aborted", "info");
      } catch (e) {
        this.onNotify(`abort failed: ${(e as Error).message}`, "error");
      }
    })();
  }

  // ────────────────────────────── SPEC-6-1: Tiers view inline edit ──────────────────────────────

  private startTiersEdit(phase: "models" | "costCap" | "contextFloor" | "add"): void {
    if (phase !== "add") {
      const sel = this.list.getSelectedItem();
      if (!sel) { this.onNotify("select a tier first", "warning"); return; }
    }
    this.tiersInput = new Input();
    this.tiersInput.onSubmit = (value: string) => { void this.executeTiersEdit(value, phase); };
    this.tiersEditPhase = phase;
    this.renderShell();
  }

  // ───────────────────────────────── SPEC-6-3: Workflows Run prompt ─────────────────────────────────

  private startWorkflowRun(definitionName: string): void {
    this.wfRunDefinitionName = definitionName;
    this.wfPromptInput = new Input();
    this.wfPromptInput.onSubmit = (prompt: string) => {
      if (prompt.trim()) {
        this.close({ action: "run", definitionName: this.wfRunDefinitionName, prompt: prompt.trim() });
      } else {
        // Blank prompt → execute the definition directly
        void this.deps.workflowController.start({
          workflowName: this.wfRunDefinitionName,
          mode: "checkpointed",
        }).then(() => {
          this.refresh();
        }).catch((e: unknown) => {
          this.onNotify(`start failed: ${(e as Error).message}`, "error");
        });
      }
      this.cancelWorkflowRun();
    };
    this.wfRunMode = true;
    this.renderShell();
  }

  private cancelWorkflowRun(): void {
    this.wfRunMode = false;
    this.wfPromptInput = null;
    this.wfRunDefinitionName = "";
    this.renderShell();
  }

  private cancelTiersEdit(): void {
    this.tiersEditPhase = null;
    this.tiersInput = null;
    this.renderShell();
  }

  private async executeTiersEdit(value: string, phase: "models" | "costCap" | "contextFloor" | "add"): Promise<void> {
    const store = this.deps.tierStore!;
    const scope = this.tiersScope;
    const sel = this.list.getSelectedItem();
    const name = sel?.value ?? "";
    if (phase === "add" && !value.trim()) { this.onNotify("tier name required", "error"); return; }
    this.tiersEditPhase = null;
    this.tiersInput = null;
    this.renderShell();
    let tiers = store.read(scope);
    try {
      if (phase === "add") {
        tiers = addTier(tiers, value.trim(), ["<placeholder-model>"]);
      } else if (phase === "models") {
        tiers = setTierModels(tiers, name, value.split(/[,\s]+/).filter(Boolean));
      } else if (phase === "costCap") {
        const n = Number(value);
        if (value.trim() !== "" && Number.isNaN(n)) { this.onNotify("costCap must be a number", "error"); return; }
        tiers = setTierCostCap(tiers, name, value.trim() === "" ? undefined : n);
      } else {
        const n = Number(value);
        if (value.trim() !== "" && Number.isNaN(n)) { this.onNotify("contextFloor must be a number", "error"); return; }
        tiers = setTierContextFloor(tiers, name, value.trim() === "" ? undefined : n);
      }
      store.write(scope, tiers);
      this.deps.reloadTiers?.();
      this.list = this.buildList();
      this.renderShell();
      if (phase === "add") this.onNotify(`tier '${value.trim()}' added; press m to edit models`, "info");
    } catch (e) {
      this.onNotify(e instanceof Error ? e.message : String(e), "error");
      return;
    }
  }

  private executeTiersDelete(): void {
    const sel = this.list.getSelectedItem();
    if (!sel) { this.onNotify("select a tier first", "warning"); return; }
    const store = this.deps.tierStore!;
    const scope = this.tiersScope;
    const tiers = deleteTier(store.read(scope), sel.value);
    try {
      store.write(scope, tiers);
      this.deps.reloadTiers?.();
      this.list = this.buildList();
      this.renderShell();
      this.onNotify(`tier '${sel.value}' deleted`, "info");
    } catch (e) {
      this.onNotify(e instanceof Error ? e.message : String(e), "error");
    }
  }

  private async executeResume(prior: RunMeta, followUp: string): Promise<void> {
    this.resumeMode = false;
    this.resumeInput = null;
    this.renderShell();
    const res: SpawnResult = await spawnSubagent({
      agent: prior.agent, task: followUp, track: true, resumeLink: prior.runId, runLog: this.deps.runLog,
      registry: this.deps.registry, todoSync: this.deps.todoSync, runRegistry: this.deps.runRegistry,
      lock: this.deps.lock, backendRegistry: this.deps.backendRegistry,
      parentModel: this.deps.parentModel, parentCwd: this.deps.parentCwd,
      defaultThinkingLevel: this.deps.defaultSubagentThinking,
      onEvent: (e) => { if (e.type === "turn_end") { this.list = this.buildList(); this.renderShell(); } },
    });
    this.list = this.buildList();
    this.renderShell();
    this.onNotify(`resume ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
  }

  /** SPEC-5b-1: Fork — fresh re-run with the same agent + task (no session rehydration). */
  private startFork(): void {
    const sel = this.list.getSelectedItem();
    if (!sel) return;
    const run = buildRunsIndex(this.deps.runLog!.dir).find((r) => r.runId === sel.value);
    if (!run) return;
    if (run.status === "running") { this.onNotify("run still running; stop it first", "warning"); return; }
    this.linkPhase = "task";
    this.taskInput = new Input();
    this.taskInput.onSubmit = (task: string) => {
      const finalTask = task.trim() || run.task;
      this.linkPhase = "link";
      this.linkInput = new Input();
      this.linkInput.onSubmit = (todoIdRaw: string) => {
        void this.executeFork(run.agent, finalTask, todoIdRaw.trim() || undefined, run.runId);
      };
      this.renderShell();
    };
    this.runMode = true;
    this.renderShell();
  }

  private async executeFork(agent: string, task: string, todoId: string | undefined, priorRunId: string): Promise<void> {
    this.runMode = false;
    this.taskInput = null;
    this.linkInput = null;
    this.renderShell();
    const res: SpawnResult = await spawnSubagent({
      agent, task, todoId, track: true, forkLink: priorRunId, runLog: this.deps.runLog,
      registry: this.deps.registry, todoSync: this.deps.todoSync, runRegistry: this.deps.runRegistry,
      lock: this.deps.lock, backendRegistry: this.deps.backendRegistry,
      parentModel: this.deps.parentModel, parentCwd: this.deps.parentCwd,
      defaultThinkingLevel: this.deps.defaultSubagentThinking,
      onEvent: (e) => { if (e.type === "turn_end") { this.list = this.buildList(); this.renderShell(); } },
    });
    this.list = this.buildList();
    this.renderShell();
    this.onNotify(`fork ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
  }

  /** SPEC-4: open the Run-lifecycle inline inputs (task → lifecycle name → start runLifecycle). */
  private startLifecycleRun(): void {
    this.lcPhase = "task";
    this.lcTaskInput = new Input();
    this.lcTaskInput.onSubmit = (task: string) => {
      if (!task.trim()) { this.cancelLifecycleRun(); return; }
      this.lcPhase = "name";
      this.lcNameInput = new Input();
      this.lcNameInput.onSubmit = (name: string) => {
        const lcName = name.trim() || "default";
        this.lcPhase = "cwd";
        this.lcCwdInput = new Input();
        // SPEC-6-5: 3rd input step — the dispatch cwd. Enter accepts the session cwd (blank)
        // or a typed path; Escape cancels the run (panel-level intercept — #63).
        this.lcCwdInput.onSubmit = (cwd: string) => {
          const picked = cwd.trim() || this.deps.parentCwd;
          void this.executeLifecycleRun(task.trim(), lcName, picked);
        };
        this.renderShell();
      };
      this.renderShell();
    };
    this.lcRunMode = true;
    this.renderShell();
  }

  private cancelLifecycleRun(): void {
    this.lcRunMode = false;
    this.lcTaskInput = null;
    this.lcNameInput = null;
    this.lcCwdInput = null;
    this.renderShell();
  }

  private async executeLifecycleRun(task: string, lifecycleName: string, cwd: string): Promise<void> {
    this.lcRunMode = false;
    this.lcTaskInput = null;
    this.lcNameInput = null;
    this.lcCwdInput = null;
    this.renderShell();
    if (!this.deps.lifecycleRegistry.has(lifecycleName)) {
      this.onNotify(`lifecycle '${lifecycleName}' not found; available: ${[...this.deps.lifecycleRegistry.keys()].sort().join(", ")}`, "error");
      return;
    }
    // SPEC-6-5: validate the chosen cwd (exists + is a dir) before spawning; surface cross-cwd.
    const { resolveDispatchCwd } = await import("../tools/subagent.ts");
    const { cwd: resolvedCwd, error: cwdErr } = resolveDispatchCwd(cwd, this.deps.parentCwd);
    if (cwdErr) { this.onNotify(cwdErr, "error"); return; }
    if (resolvedCwd && resolvedCwd !== this.deps.parentCwd) {
      this.onNotify("scoped to " + resolvedCwd + " (≠ session " + this.deps.parentCwd + ")", "info");
    }
    const onCheckpoint: CheckpointFn = (phase) => new Promise<CheckpointDecision>((resolve) => {
      this.pendingCheckpoint = { phase, resolve };
      this.renderShell();
    });
    const lifecycleFullDeps: LifecycleRunDeps = {
      ...this.deps.lifecycleDeps,
      spawn: async (o) => {
        const { spawnSubagent } = await import("../engine/spawnSubagent.ts");
        return spawnSubagent({
          agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
            skillsOverride: o.skills, backendOverride: o.backend,
          registry: this.deps.registry, todoSync: this.deps.todoSync, runRegistry: this.deps.runRegistry, lock: this.deps.lock,
          backendRegistry: this.deps.backendRegistry, parentModel: this.deps.parentModel, parentCwd: this.deps.parentCwd,
          runLog: this.deps.runLog,
          defaultThinkingLevel: this.deps.defaultSubagentThinking,
          cwd: o.cwd,
        });
      },
    };
    const res = await runLifecycle(task, lifecycleName, { deps: lifecycleFullDeps, mode: "checkpointed", onCheckpoint, entryCwd: resolvedCwd });
    this.pendingCheckpoint = null;
    // record the run so the Lifecycle view shows it
    this.deps.lifecycleRuns.set(res.runId, res);
    this.list = this.buildList();
    this.renderShell();
    this.onNotify(`lifecycle ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
  }
}

/** Factory used by src/index.ts to open the panel via ctx.ui.custom. */
export function openFleetPanel(
  deps: FleetPanelDeps,
  ctx: {
    ui: {
      custom: (factory: (tui: unknown, theme: Theme, kb: unknown, done: () => void) => Container) => void;
      notify: (m: string, t?: "info" | "warning" | "error") => void;
    };
  },
): void {
  ctx.ui.custom((_tui, theme, _kb, done) => {
    return new FleetPanel({ theme, deps, onDone: done, onNotify: (m, t) => ctx.ui.notify(m, t) });
  });
}
