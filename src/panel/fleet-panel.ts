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
import type { RunRecord } from "../engine/run-registry.ts";
import { fleetRow, agentsRow, agentInfo } from "./rows.ts";
import { spawnSubagent, type SpawnResult } from "../engine/spawnSubagent.ts";
import type { BackendRegistry } from "../backend/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";

type View = "fleet" | "agents";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;   // SPEC-3: replaces childFactory
  parentModel: { provider: string; id: string };
  parentCwd: string;
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
  }

  private buildList(): SelectList {
    const items: SelectItem[] =
      this.view === "fleet"
        ? this.deps.runRegistry.list().map((r: RunRecord) => ({ value: r.runId, label: fleetRow(r) }))
        : [...this.deps.registry.values()].map((a: AgentDef) => ({ value: a.name, label: agentsRow(a) }));
    const fresh = new SelectList(items, 12, {
      selectedPrefix: (s: string) => this.theme.fg("accent", s),
      selectedText: (s: string) => this.theme.fg("accent", s),
      description: (s: string) => this.theme.fg("muted", s),
      scrollInfo: (s: string) => this.theme.fg("dim", s),
      noMatch: (s: string) => this.theme.fg("warning", s),
    });
    fresh.onSelect = (item: SelectItem) => this.onSelect(item.value);
    fresh.onCancel = () => this.onDone();
    return fresh;
  }

  private renderShell(): void {
    const keep = this.children.slice(0, 2);
    this.children.length = 0;
    this.children.push(...keep);
    const accent = (s: string): string => this.theme.fg("accent", s);
    const tabs = (["fleet", "agents"] as View[])
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
    } else {
      this.addChild(this.list);
    }

    this.addChild(new Spacer(1));
    const hint =
      this.infoAgent
        ? "  esc:Back"
        : this.view === "fleet"
          ? "  r:Run-new  s:Stop  o:Open-todo  tab:Agents  q:Quit"
          : "  r:Run  e:Edit  i:Info  d:Reload  tab:Fleet  q:Quit";
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
    this.view = this.view === "fleet" ? "agents" : "fleet";
    this.list = this.buildList();
    this.renderShell();
  }

  handleInput(data: string): void {
    if (this.infoAgent) {
      if (matchesKey(data, "escape")) { this.infoAgent = null; this.renderShell(); }
      return;
    }
    if (this.runMode && (this.taskInput || this.linkInput)) {
      if (matchesKey(data, "escape")) { this.cancelRun(); return; }
      (this.linkPhase === "task" ? this.taskInput! : this.linkInput!).handleInput(data);
      this.invalidate();
      return;
    }
    if (matchesKey(data, "escape")) { this.onDone(); return; }
    if (matchesKey(data, "tab")) { this.switchView(); return; }
    if (matchesKey(data, "q")) { this.onDone(); return; }
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
    this.list.handleInput(data);
    this.invalidate();
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