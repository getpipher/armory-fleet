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
import type { AgentDef } from "../registry/frontmatter.ts";
import { agentsRow, agentInfo, backendsRow, backendInfo, lifecycleRow, lifecyclePhaseTimeline, scheduleRow } from "./rows.ts";
import { buildFleetItems } from "./fleet-items.ts";
import { runsRow, runTimelineRow } from "./runs-rows.ts";
import { buildRunsIndex } from "./runs-index.ts";
import type { RunLog, RunMeta, RunLogEvent } from "../runtime/run-log.ts";
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

type View = "fleet" | "lifecycle" | "runs" | "agents" | "backends" | "scheduled";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory
  parentModel: { provider: string; id: string };
  parentCwd: string;
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
}

export interface FleetPanelOpts {
  theme: Theme;
  deps: FleetPanelDeps;
  onDone: () => void;
  onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
}

export class FleetPanel extends Container {
  private readonly theme: Theme;
  private readonly deps: FleetPanelDeps;
  private readonly onDone: () => void;
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
  private lcPhase: "task" | "name" = "task";
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
  /** SPEC-5a proper-fix: store-change subscriptions — fired by RunRegistry + BgRunsStore
   * so the panel re-renders the moment a (fore- or back-ground) run mutates, without a keypress. */
  private readonly unsubs: (() => void)[] = [];
  private closed = false;   // SPEC-5a proper-fix: guard against double-close calling onDone twice

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
  }

  private buildList(): SelectList {
    const items: SelectItem[] =
      this.view === "fleet"
        ? buildFleetItems({ runRegistry: this.deps.runRegistry, bgRuns: this.deps.bgRuns })
        : this.view === "lifecycle"
          ? [...this.deps.lifecycleRuns.values()].map((l: LifecycleRunRecord) => ({ value: l.runId, label: lifecycleRow(l) }))
          : this.view === "runs"
            ? buildRunsIndex(this.deps.runLog?.dir ?? "").map((r: RunMeta) => ({ value: r.runId, label: runsRow(r) }))
            : this.view === "agents"
              ? [...this.deps.registry.values()].map((a: AgentDef) => ({ value: a.name, label: agentsRow(a) }))
            : this.view === "scheduled"
              ? (this.deps.scheduler?.list() ?? []).map((s: Schedule) => ({ value: s.id, label: scheduleRow(s) }))
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
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.onDone();
  }

  private renderShell(): void {
    const keep = this.children.slice(0, 2);
    this.children.length = 0;
    this.children.push(...keep);
    const accent = (s: string): string => this.theme.fg("accent", s);
    const tabs = (["fleet", "lifecycle", "agents", "backends", "scheduled"] as View[])
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
    } else if (this.selectedRun) {
      // SPEC-5b-1: Runs tab — per-turn timeline replay (read-only); enter reserved for 5b-3 overlay.
      this.addChild(new Text(this.theme.fg("dim", `  ── run ${this.selectedRun.runId} — timeline ──`), 0, 0));
      const events = (this.runTimeline ?? []).filter((e) => e.type === "message" || e.type === "tool") as Array<RunLogEvent>;
      if (events.length === 0) {
        this.addChild(new Text(this.theme.fg("dim", "  (no conversation events)"), 0, 0));
      } else {
        const tl = new SelectList(
          events.map((e) => ({ value: "", label: runTimelineRow(e as never) })),
          Math.min(events.length, 12),
          {
            selectedPrefix: (s: string) => this.theme.fg("accent", s),
            selectedText: (s: string) => this.theme.fg("accent", s),
            description: (s: string) => this.theme.fg("muted", s),
            scrollInfo: (s: string) => this.theme.fg("dim", s),
            noMatch: (s: string) => this.theme.fg("warning", s),
          },
        );
        tl.onCancel = () => { this.selectedRun = null; this.runTimeline = null; this.renderShell(); };
        this.addChild(tl);
      }
      this.addChild(new Text(this.theme.fg("dim", "  enter: (5b-3 full message)  esc:Back"), 0, 0));
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
    } else if (this.lcRunMode && (this.lcTaskInput || this.lcNameInput)) {
      const prompt = this.lcPhase === "task" ? "  task> " : "  lifecycle name (blank=default)> ";
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.lcPhase === "task" ? this.lcTaskInput! : this.lcNameInput!);
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
      this.infoAgent || this.selectedBackend || this.selectedLifecycle || this.selectedSchedule || this.selectedRun
        ? (this.selectedRun ? "  enter:(5b-3)  esc:Back" : "  esc:Back")
        : this.pendingCheckpoint
          ? "  c:Continue  v:Revise  a:Abort"
          : this.lcRevising
            ? "  enter:Submit-feedback  esc:Cancel"
            : this.view === "fleet"
              ? "  r:Run-new  s:Stop  o:Open-todo  tab:Lifecycle  q:Quit"
              : this.view === "lifecycle"
                ? "  r:Run-lifecycle  i:Info  tab:Runs  q:Quit"
                : this.view === "runs"
                  ? "  enter:Replay  r:Resume  f:Fork  tab:Agents  q:Quit"
                  : this.view === "agents"
                  ? "  r:Run  e:Edit  i:Info  d:Reload  tab:Backends  q:Quit"
                  : this.view === "scheduled"
                    ? "  a:Add  p:Pause/resume  d:Delete  i:Info  tab:Fleet  q:Quit"
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
      this.linkInput.onEscape = () => { void this.executeRun(agentName, task.trim(), undefined); };
      this.renderShell();
    };
    this.taskInput.onEscape = () => this.cancelRun();
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
      : this.view === "backends" ? "scheduled" : "fleet";
    this.selectedBackend = null;
    this.selectedLifecycle = null;
    this.selectedSchedule = null;
    this.selectedRun = null;
    this.runTimeline = null;
    this.list = this.buildList();
    this.renderShell();
  }

  handleInput(data: string): void {
    if (this.infoAgent) {
      if (matchesKey(data, "escape")) { this.infoAgent = null; this.renderShell(); }
      return;
    }
    if (this.selectedBackend) {
      if (matchesKey(data, "escape")) { this.selectedBackend = null; this.renderShell(); }
      return;
    }
    if (this.selectedLifecycle) {
      if (matchesKey(data, "escape")) { this.selectedLifecycle = null; this.renderShell(); }
      return;
    }
    if (this.selectedSchedule) {
      if (matchesKey(data, "escape")) { this.selectedSchedule = null; this.renderShell(); }
      return;
    }
    if (this.selectedRun) {
      // SPEC-5b-1: Runs timeline replay overlay — esc back; enter is a 5b-3 placeholder.
      if (matchesKey(data, "escape")) { this.selectedRun = null; this.runTimeline = null; this.renderShell(); }
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
    if (this.lcRunMode && (this.lcTaskInput || this.lcNameInput)) {
      if (matchesKey(data, "escape")) { this.cancelLifecycleRun(); return; }
      (this.lcPhase === "task" ? this.lcTaskInput! : this.lcNameInput!).handleInput(data);
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
    // SPEC-5b-1: Runs view — enter/i:Replay  R:Resume  F:Fork
    if (this.view === "runs" && this.deps.runLog) {
      if (matchesKey(data, "enter") || matchesKey(data, "i")) {
        const sel = this.list.getSelectedItem();
        if (sel) {
          this.selectedRun = buildRunsIndex(this.deps.runLog.dir).find((r) => r.runId === sel.value) ?? null;
          this.runTimeline = this.deps.runLog.replay(sel.value);
          this.renderShell();
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
        this.lcReviseInput.onEscape = () => { this.lcRevising = false; this.lcReviseInput = null; this.renderShell(); };
        this.renderShell();
        return;
      }
    }
    if (this.lcRevising && this.lcReviseInput) {
      if (matchesKey(data, "escape")) { this.lcRevising = false; this.lcReviseInput = null; this.renderShell(); return; }
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
        this.schedNameInput.onEscape = () => { this.executeScheduleAdd(task.trim(), expr.trim(), "default"); };
        this.renderShell();
      };
      this.schedExprInput.onEscape = () => this.cancelScheduleAdd();
      this.renderShell();
    };
    this.schedTaskInput.onEscape = () => this.cancelScheduleAdd();
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
    this.resumeInput.onEscape = () => this.cancelResume();
    this.resumeMode = true;
    this.renderShell();
  }

  private cancelResume(): void {
    this.resumeMode = false;
    this.resumeInput = null;
    this.renderShell();
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
      this.linkInput.onEscape = () => { void this.executeFork(run.agent, finalTask, undefined, run.runId); };
      this.renderShell();
    };
    this.taskInput.onEscape = () => this.cancelRun();
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
        void this.executeLifecycleRun(task.trim(), lcName);
      };
      this.lcNameInput.onEscape = () => { void this.executeLifecycleRun(task.trim(), "default"); };
      this.renderShell();
    };
    this.lcTaskInput.onEscape = () => this.cancelLifecycleRun();
    this.lcRunMode = true;
    this.renderShell();
  }

  private cancelLifecycleRun(): void {
    this.lcRunMode = false;
    this.lcTaskInput = null;
    this.lcNameInput = null;
    this.renderShell();
  }

  private async executeLifecycleRun(task: string, lifecycleName: string): Promise<void> {
    this.lcRunMode = false;
    this.lcTaskInput = null;
    this.lcNameInput = null;
    this.renderShell();
    if (!this.deps.lifecycleRegistry.has(lifecycleName)) {
      this.onNotify(`lifecycle '${lifecycleName}' not found; available: ${[...this.deps.lifecycleRegistry.keys()].sort().join(", ")}`, "error");
      return;
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
        });
      },
    };
    const res = await runLifecycle(task, lifecycleName, { deps: lifecycleFullDeps, mode: "checkpointed", onCheckpoint });
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