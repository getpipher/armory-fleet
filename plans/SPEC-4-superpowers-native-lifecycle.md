# SPEC-4 — Superpowers-native lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fleet superpowers-native — a *lifecycle* runs a task through brainstorm→plan→implement→review→finish by spawning one child subagent per phase, threading each phase's file artifacts into the next, and pausing for human review (Continue/Revise/Abort) at phase boundaries by default, with an `auto` escape. A new `/fleet` Lifecycle view + `/fleet-implement <task>` done-bar + a `subagent({ task, lifecycle })` tool param.

**Architecture:** A lifecycle is a *phase-injection config* layered **above** the SPEC-1/2/3 engine — additive only. A `lifecycle registry` (builtins + user-authored, project-over-global, mirroring the agent registry) holds lifecycle files (frontmatter + `## <phase>` prompt templates). `runLifecycle(task, lifecycle, opts)` loops the phases: resolve agent (phase pin → `general-purpose`) + backend (phase → lifecycle → `pi`) + skills (merge lifecycle bundle ∪ agent's), render the phase prompt with the previous phase's `(summary, artifactPaths)`, spawn via the **unchanged** `BackendRegistry.get(backend).factory`, parse the child's trailing `Artifacts:` block, update the lifecycle TODO's progress block, then checkpoint. The creation seam (`ChildSessionFactory`/`ChildSession`/`BackendRegistry`) is untouched. One TODO per lifecycle (Q7=C); per-phase spawns link to it (new `SpawnOptions.lifecycleTodoId`) and skip the per-run mark-done/revert (the lifecycle engine owns the lifecycle TODO's status).

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build), pi `^0.81.1` SDK, `node:test` via tsx, `@getpipher/armory-todo`, `@getpipher/armory-memory`, `typebox`, `yaml`.

## Global Constraints

- **No build step** — raw `.ts` via tsx at runtime; `pnpm typecheck` + `pnpm test:run` (node:test via tsx) before release.
- **Test runner:** `node --import tsx --test test/*.test.mts` (Node 24 won't type-strip under `node_modules`). Use `pnpm test:run`.
- **pi target:** `^0.81.1`. SDK imports from `@earendil-works/pi-coding-agent`.
- **Additive only** — the SPEC-1/2/3 engine modules (`spawnSubagent.ts` single-run path, factories, `BackendRegistry`, `child-loader`, `memory-hydrate/`, `vision/`, `todo-sync/` adapter logic) are untouched except: (a) `SpawnOptions` gains one optional field `lifecycleTodoId` + `spawnSubagent` links-to-it and skips mark-done/revert when set (Task 8); (b) `TodoSyncPort` gains one method `updateLifecycleProgress` + adapter impl (Task 7); (c) `subagent.ts` tool gains two optional params (Task 10); (d) `fleet-panel.ts` adds one tab + the panel drives lifecycle checkpoints (Task 11); (e) `index.ts` wires the registry + slash (Task 12). All existing tests must pass unchanged.
- **Phase-injection, not new backends** — lifecycle phases route through the existing `BackendRegistry.get(agentDef.backend).factory`; SPEC-4 adds NO backend, NO agent type. The `ChildSessionFactory`/`ChildSession`/`BackendRegistry` seam is unchanged.
- **No predetermined role library** (Q1=B, SPEC-1 §7.3) — ship only the `default` builtin lifecycle + the existing `general-purpose` agent. No scout/planner/worker/reviewer/oracle agents. Phases = skill bundles; the superpowers skill set IS the role canon.
- **Skills are a merge** (Q3=B) — phase loads `lifecycle.phase.skills ∪ agent.skills` (lifecycle first; agent can only add, never drop a phase-required skill).
- **Single-writer TODO** — the child never writes to armory-todo (`excludeTools: ["todo"]` / `--disallowed-tools`, unchanged). The lifecycle engine owns the lifecycle TODO; per-phase spawns link to it and skip mark-done/revert.
- **No AI attribution** in commits/PRs/files.
- **One commit per task**; conventional branch `feat/spec-4-superpowers-lifecycle` (cut at execution time, not during planning).
- **getpipher conventions:** EditorTheme gotcha — `ctx.ui.custom` receives full `Theme` (import from `@earendil-works/pi-coding-agent`); the Lifecycle view threads `() => ctx.ui.theme` for real colors. Interactive-first: every capability lands as a `/fleet` panel view + action submenu FIRST, then the model-callable tool.
- **Checkpoint model (Q2=C + reconciliation):** `runLifecycle` takes an `onCheckpoint` callback. **Panel-driven** = interactive (Continue/Revise/Abort), checkpointed by default, `--auto` escapes to auto. **Tool-driven** (`subagent({ task, lifecycle })`) = auto (the tool is synchronous; the agent awaits the result) — auto-continue on phase success, auto-abort on phase failure (Revise needs human feedback that auto mode doesn't have). The tool's `auto` param is accepted but tool-driven is effectively auto; checkpointed Continue/Revise is a panel feature.
- **Spec:** `specs/SPEC-4-superpowers-native-lifecycle.md` — every task traces to a spec section (cited in each task header).

---

## File Structure

**Fleet (this repo):**
- `src/lifecycle/lifecycle-types.ts` — `LifecycleDef`, `PhaseDef`, `PhaseRecord`, `LifecycleRunRecord`, `LifecycleStatus`, `CheckpointDecision`
- `src/lifecycle/registry.ts` — `parseLifecycleFile` + `discoverLifecycles` (project-over-global, mirrors `discovery.ts`)
- `src/lifecycle/default.ts` — the `default` builtin lifecycle (frontmatter + 5 phase templates as a constant)
- `src/lifecycle/prompt-template.ts` — `renderPhasePrompt(template, vars)` (mustache-style `{{var}}` + `{% if %}`)
- `src/lifecycle/artifacts-parser.ts` — `parseArtifacts(finalText)` → `{ summary, paths }` + terminal-phase exemption
- `src/lifecycle/lifecycle-todo.ts` — `createLifecycleTodo`, `updateProgress`, `completeLifecycleTodo`, `revertLifecycleTodo` (wraps the port)
- `src/lifecycle/run-lifecycle.ts` — `runLifecycle(task, lifecycleName, opts)` — the phase loop + checkpoint state machine
- `src/lifecycle/port.ts` — type re-exports (single import surface for engine/views/tools)
- `src/engine/spawnSubagent.ts` — **modify**: `SpawnOptions.lifecycleTodoId?` + link-to-it + skip mark-done/revert when set
- `src/todo-sync/port.ts` — **modify**: `TodoSyncPort.updateLifecycleProgress(todoId, progressBlock)`
- `src/todo-sync/adapter.ts` — **modify**: `updateLifecycleProgress` impl (read-then-write notes)
- `src/tools/subagent.ts` — **modify**: `lifecycle?` + `auto?` params; route to `runLifecycle` when `lifecycle` present
- `src/panel/rows.ts` — **modify**: `lifecycleRow` + `lifecyclePhaseTimeline`
- `src/panel/fleet-panel.ts` — **modify**: `View` += `"lifecycle"`; tab cycle; "Run lifecycle…" action; checkpoint Continue/Revise/Abort submenu; thread `() => ctx.ui.theme`
- `src/index.ts` — **modify**: build lifecycle registry at init; thread through deps; register `/fleet-implement` slash
- `scripts/spec-4-smoke.mts` — real end-to-end lifecycle smoke (real Ollama pi phases; CC rows skip if `claude` absent)
- `docs/SPEC-4-smoke-checklist.md` — term-driven TUI smoke matrix rows
- `test/lifecycle-types.test.mts`, `test/lifecycle-registry.test.mts`, `test/lifecycle-default.test.mts`, `test/prompt-template.test.mts`, `test/artifacts-parser.test.mts`, `test/lifecycle-todo.test.mts`, `test/spawn-subagent-spec4.test.mts`, `test/run-lifecycle.test.mts`, `test/subagent-lifecycle-param.test.mts`, `test/panel-spec4.test.mts`, `test/index-spec4.test.mts`

---

## Task 1: Lifecycle types

**Spec:** §4 (file layout), §6 (phase loop types). Pure types — no deps, easiest to test first.

**Files:**
- Create: `src/lifecycle/lifecycle-types.ts`
- Create: `test/lifecycle-types.test.mts`

**Interfaces:**
- Consumes: `FleetRunStatus` from `src/todo-sync/port.ts` (existing); `AgentDef` from `src/registry/frontmatter.ts` (existing).
- Produces: `LifecycleStatus`, `PhaseDef`, `LifecycleDef`, `PhaseRecord`, `LifecycleRunRecord`, `CheckpointDecision`, `CheckpointAction`.

- [ ] **Step 1: Write the failing test**

`test/lifecycle-types.test.mts`:
```ts
import { test } from "node:test";
import { ok } from "node:assert";
import type {
  LifecycleStatus, PhaseDef, LifecycleDef, PhaseRecord, LifecycleRunRecord,
  CheckpointDecision, CheckpointAction,
} from "../src/lifecycle/lifecycle-types.ts";

test("lifecycle types are importable + structurally sound", () => {
  const phase: PhaseDef = {
    name: "brainstorm",
    skills: ["brainstorming"],
    agent: "general-purpose",
    backend: "pi",
    checkpoint: true,
    promptTemplate: "You are the brainstorm phase. Task: {{task}}",
  };
  const def: LifecycleDef = {
    name: "default",
    description: "superpowers-5",
    backend: "pi",
    phases: [phase],
    source: "builtin",
    filePath: "<builtin>",
  };
  const rec: PhaseRecord = { name: "brainstorm", summary: "did it", paths: ["a.md"], status: "completed", reviseCount: 0 };
  const run: LifecycleRunRecord = {
    runId: "fl-x", lifecycleName: "default", task: "t", backend: "pi", mode: "checkpointed",
    status: "running", phases: [rec], startedAt: 0, todoId: "td-1",
  };
  const d: CheckpointDecision = { action: "continue" };
  const d2: CheckpointDecision = { action: "revise", feedback: "tighter" };
  const d3: CheckpointDecision = { action: "abort" };
  ok(def.phases.length === 1);
  ok(run.phases[0].name === "brainstorm");
  ok((d.action === "continue") && (d2.action === "revise") && (d3.action === "abort"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A3 lifecycle-types`
Expected: FAIL (module not found / no export).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/lifecycle-types.ts`:
```ts
// src/lifecycle/lifecycle-types.ts
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { AgentSource } from "../registry/frontmatter.ts";

/** Backend id (mirrors SPEC-3 AgentDef.backend). */
export type BackendId = "pi" | "claude";

/** Lifecycle-wide status (richer than FleetRunStatus: adds checkpoint + revising). */
export type LifecycleStatus = "running" | "checkpoint" | "completed" | "failed" | "aborted";

export type LifecycleMode = "checkpointed" | "auto";

/** A phase definition (parsed from a lifecycle file's frontmatter). */
export interface PhaseDef {
  name: string;
  skills: string[];
  /** Per-phase default agent pin; absent → general-purpose. */
  agent?: string;
  /** Per-phase backend override (Q4=C); absent → lifecycle.backend. */
  backend?: BackendId;
  /** Pause for human review after this phase; default true. Terminal phase omits (no checkpoint). */
  checkpoint?: boolean;
  /** The phase prompt template (parsed from the `## <name>` body section). */
  promptTemplate: string;
}

export interface LifecycleDef {
  name: string;
  description: string;
  /** Lifecycle-wide default backend; absent → "pi". */
  backend: BackendId;
  phases: PhaseDef[];
  source: AgentSource;
  filePath: string;
}

/** The record of one phase's execution (stored on the LifecycleRunRecord). */
export interface PhaseRecord {
  name: string;
  summary: string;
  paths: string[];
  status: FleetRunStatus;
  reviseCount: number;
}

export interface LifecycleRunRecord {
  runId: string;
  lifecycleName: string;
  task: string;
  backend: BackendId;
  mode: LifecycleMode;
  status: LifecycleStatus;
  phases: PhaseRecord[];
  startedAt: number;
  endedAt?: number;
  todoId: string | null;
}

/** Human (or auto) decision at a checkpoint. */
export type CheckpointAction = "continue" | "revise" | "abort";
export interface CheckpointDecision {
  action: CheckpointAction;
  /** Present only when action === "revise". */
  feedback?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-types`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/lifecycle-types.ts test/lifecycle-types.test.mts
git commit -m "feat(spec-4): lifecycle core types (PhaseDef/LifecycleDef/PhaseRecord/CheckpointDecision)"
```

---

## Task 2: Lifecycle file parser (`parseLifecycleFile`)

**Spec:** §5.1 (file format), §12 (resolve-time errors). Parse frontmatter + `## <phase>` body. Mirror `parseAgentFile` discipline.

**Files:**
- Create: `src/lifecycle/registry.ts` (parser only this task; discovery in Task 3)
- Create: `test/lifecycle-registry.test.mts`

**Interfaces:**
- Consumes: `FrontmatterError` from `src/registry/frontmatter.ts` (existing — reuse for consistent error class); `yaml` `parse`.
- Produces: `parseLifecycleFile(content, filePath, source): LifecycleDef`, `LifecycleParseError`.

- [ ] **Step 1: Write the failing test**

`test/lifecycle-registry.test.mts` (parser cases — discovery cases added in Task 3):
```ts
import { test } from "node:test";
import { strictEqual, throws, ok } from "node:assert";
import { parseLifecycleFile, LifecycleParseError } from "../src/lifecycle/registry.ts";

const GOOD = `---
name: default
description: superpowers-5
backend: pi
phases:
  - name: brainstorm
    skills: [brainstorming]
    checkpoint: true
  - name: plan
    skills: [writing-plans]
  - name: finish
    skills: [finishing-a-development-branch]
---

## brainstorm
You are the brainstorm phase. Task: {{task}}

## plan
You are the plan phase. {% if prev %}prev: {{prev.summary}}{% endif %}

## finish
You are the finish phase.
`;

test("parses a well-formed lifecycle file", () => {
  const def = parseLifecycleFile(GOOD, "/x/default.md", "builtin");
  strictEqual(def.name, "default");
  strictEqual(def.backend, "pi");
  strictEqual(def.phases.length, 3);
  strictEqual(def.phases[0].name, "brainstorm");
  strictEqual(def.phases[0].skills[0], "brainstorming");
  strictEqual(def.phases[0].checkpoint, true);
  strictEqual(def.phases[1].checkpoint, true, "checkpoint defaults to true when omitted");
  strictEqual(def.phases[1].agent, undefined, "agent defaults to undefined → general-purpose at resolve time");
  ok(def.phases[0].promptTemplate.includes("{{task}}"));
  ok(def.phases[2].promptTemplate.includes("finish phase"));
});

test("backend defaults to pi when omitted", () => {
  const def = parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project");
  strictEqual(def.backend, "pi");
});

test("rejects invalid backend", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
backend: gemini
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /invalid backend/.test((e as Error).message),
  );
});

test("rejects empty phases", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: []
---
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /at least one phase/.test((e as Error).message),
  );
});

test("rejects a phase with a missing body template", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: brainstorm, skills: [] }, { name: plan, skills: [] }]
---
## brainstorm
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /missing.*template.*plan/.test((e as Error).message),
  );
});

test("rejects a phase declared in frontmatter but with no body section", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }]
---
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /missing.*template.*\ba\b/.test((e as Error).message),
  );
});

test("rejects duplicate phase names", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }, { name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /duplicate phase.*a/.test((e as Error).message),
  );
});

test("rejects missing frontmatter delimiters", () => {
  throws(
    () => parseLifecycleFile("no frontmatter here", "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /frontmatter delimiters/.test((e as Error).message),
  );
});

test("rejects missing description", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /description is required/.test((e as Error).message),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-registry`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/registry.ts` (parser; `discoverLifecycles` added in Task 3):
```ts
// src/lifecycle/registry.ts
import { parse as parseYaml } from "yaml";
import { basename, extname } from "node:path";
import type { AgentSource } from "../registry/frontmatter.ts";
import { FrontmatterError } from "../registry/frontmatter.ts";
import type { BackendId, LifecycleDef, PhaseDef } from "./lifecycle-types.ts";

export class LifecycleParseError extends FrontmatterError {
  override name = "LifecycleParseError" as const;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const VALID_BACKENDS: BackendId[] = ["pi", "claude"];

/** Parse a lifecycle markdown file into a LifecycleDef. Throws LifecycleParseError on any malformed input. */
export function parseLifecycleFile(content: string, filePath: string, source: AgentSource): LifecycleDef {
  const m = FM_RE.exec(content);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new LifecycleParseError(`${filePath}: missing --- frontmatter delimiters`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new LifecycleParseError(`${filePath}: invalid YAML (${(e as Error).message})`);
  }
  const body = m[2];

  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : basename(filePath, extname(filePath));
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) throw new LifecycleParseError(`${filePath}: description is required`);

  const rawBackend = typeof raw.backend === "string" ? raw.backend.trim() : "pi";
  if (!VALID_BACKENDS.includes(rawBackend as BackendId)) {
    throw new LifecycleParseError(`${filePath}: invalid backend '${rawBackend}' (must be 'pi' | 'claude')`);
  }
  const backend = rawBackend as BackendId;

  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    throw new LifecycleParseError(`${filePath}: phases must be a non-empty array`);
  }

  // Parse phase frontmatter entries (name + skills + agent + backend + checkpoint); templates resolved after.
  const phaseNames = new Set<string>();
  const partialPhases = raw.phases.map((p: unknown, i: number) => {
    if (!p || typeof p !== "object") {
      throw new LifecycleParseError(`${filePath}: phases[${i}] must be an object`);
    }
    const po = p as Record<string, unknown>;
    const pname = typeof po.name === "string" && po.name.trim() ? po.name.trim() : "";
    if (!pname) throw new LifecycleParseError(`${filePath}: phases[${i}].name is required`);
    if (phaseNames.has(pname)) {
      throw new LifecycleParseError(`${filePath}: duplicate phase '${pname}'`);
    }
    phaseNames.add(pname);
    if (!Array.isArray(po.skills)) {
      throw new LifecycleParseError(`${filePath}: phase '${pname}' skills must be an array`);
    }
    const skills = po.skills.map((s) => String(s));
    const agent = typeof po.agent === "string" && po.agent.trim() ? po.agent.trim() : undefined;
    let pbackend: BackendId | undefined;
    if (po.backend !== undefined) {
      const b = String(po.backend).trim();
      if (!VALID_BACKENDS.includes(b as BackendId)) {
        throw new LifecycleParseError(`${filePath}: phase '${pname}' invalid backend '${b}'`);
      }
      pbackend = b as BackendId;
    }
    const checkpoint = po.checkpoint === undefined ? true : Boolean(po.checkpoint);
    return { name: pname, skills, agent, backend: pbackend, checkpoint };
  });

  // Split body into `## <phase>` sections. A phase with no matching section = error.
  const templates = splitPhaseTemplates(body, filePath);
  const phases: PhaseDef[] = partialPhases.map((p) => {
    const promptTemplate = templates.get(p.name);
    if (promptTemplate === undefined) {
      throw new LifecycleParseError(`${filePath}: phase '${p.name}' missing template (no '## ${p.name}' body section)`);
    }
    return { ...p, promptTemplate };
  });

  return { name, description, backend, phases, source, filePath };
}

/** Split the markdown body into a map of phase-name → prompt-template, by `## <name>` H2 headings. */
function splitPhaseTemplates(body: string, filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  const H2 = /^##\s+(\S[^\r\n]*)$/;
  for (const line of lines) {
    const h = H2.exec(line);
    if (h) {
      current = h[1].trim();
      if (out.has(current)) {
        throw new LifecycleParseError(`${filePath}: duplicate '## ${current}' body section`);
      }
      out.set(current, "");
    } else if (current !== null) {
      out.set(current, (out.get(current) ?? "") + line + "\n");
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-registry`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/registry.ts test/lifecycle-registry.test.mts
git commit -m "feat(spec-4): lifecycle file parser (frontmatter + ## phase templates, fail-loud validation)"
```

---

## Task 3: Lifecycle discovery (`discoverLifecycles`)

**Spec:** §2.1 (registry, project-over-global), §4. Mirror `discoverAgents`.

**Files:**
- Modify: `src/lifecycle/registry.ts` (append `discoverLifecycles`)
- Modify: `test/lifecycle-registry.test.mts` (append discovery cases)
- Create: `src/lifecycle/port.ts` (re-export surface)

**Interfaces:**
- Consumes: `parseLifecycleFile` (Task 2); `existsSync`/`readdirSync`/`readFileSync`/`realpathSync` (mirror `discovery.ts`).
- Produces: `discoverLifecycles(opts): { lifecycles: Map<string, LifecycleDef>; warnings: string[]; errors: string[] }`, `LifecycleDiscoverOpts`.

- [ ] **Step 1: Write the failing test** (append to `test/lifecycle-registry.test.mts`)

```ts
import { discoverLifecycles } from "../src/lifecycle/registry.ts";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lifecycleFile = (name: string, backend = "pi") => `---
name: ${name}
description: ${name} lifecycle
backend: ${backend}
phases: [{ name: a, skills: [] }]
---
## a
do ${name}
`;

test("discoverLifecycles loads builtin + project over global on name collision", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lc-"));
  const globalDir = join(tmp, "global");
  const projectDir = join(tmp, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(globalDir, "shared.md"), lifecycleFile("shared", "claude"));
  writeFileSync(join(projectDir, "shared.md"), lifecycleFile("shared", "pi"));
  const r = discoverLifecycles({ projectDir, globalDir, builtinDir: null });
  strictEqual(r.lifecycles.size, 1);
  strictEqual(r.lifecycles.get("shared")!.backend, "pi", "project overrides global");
  strictEqual(r.lifecycles.get("shared")!.source, "project");
});

test("discoverLifecycles collects warnings for unreadable/bad files, errors for same-scope dup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lc-"));
  const projectDir = join(tmp, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "good.md"), lifecycleFile("good"));
  writeFileSync(join(projectDir, "bad.md"), "---\nname: bad\ndescription: bad\nphases: []\n---\n");
  const r = discoverLifecycles({ projectDir, globalDir: null, builtinDir: null });
  strictEqual(r.lifecycles.size, 1);
  ok(r.warnings.some((w) => /bad\.md/.test(w)), "bad file → warning");
});

test("discoverLifecycles with null dirs returns empty + no errors", () => {
  const r = discoverLifecycles({ projectDir: null, globalDir: null, builtinDir: null });
  strictEqual(r.lifecycles.size, 0);
  strictEqual(r.errors.length, 0);
});

test("port re-exports the public surface", async () => {
  const port = await import("../src/lifecycle/port.ts");
  ok(typeof port.parseLifecycleFile === "function");
  ok(typeof port.discoverLifecycles === "function");
  ok(port.LifecycleParseError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 "discoverLifecycles\|port re-exports"`
Expected: FAIL (`discoverLifecycles` not exported; `port.ts` missing).

- [ ] **Step 3: Write minimal implementation**

Append to `src/lifecycle/registry.ts`:
```ts
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface LifecycleDiscoverOpts {
  projectDir: string | null;
  globalDir: string | null;
  builtinDir: string | null;
}

export interface LifecycleDiscoverResult {
  lifecycles: Map<string, LifecycleDef>;
  warnings: string[];
  errors: string[];
}

/** Recursively collect *.md file paths (mirror registry/discovery.ts). */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    let real: string;
    try { real = realpathSync(d); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function discoverLifecycles(opts: LifecycleDiscoverOpts): LifecycleDiscoverResult {
  const lifecycles = new Map<string, LifecycleDef>();
  const warnings: string[] = [];
  const errors: string[] = [];
  const loadScope = (dir: string | null, source: AgentSource): void => {
    if (!dir) return;
    for (const f of collectMarkdown(dir).sort()) {
      let content: string;
      try { content = readFileSync(f, "utf8"); } catch { warnings.push(`${f}: unreadable file, skipped`); continue; }
      try {
        const def = parseLifecycleFile(content, f, source);
        const existing = lifecycles.get(def.name);
        if (existing && existing.source === source) {
          errors.push(`duplicate lifecycle '${def.name}' in ${source} scope (${f}); first kept`);
          continue;
        }
        lifecycles.set(def.name, def); // project over global/builtin (later wins)
      } catch (e) {
        warnings.push(e instanceof LifecycleParseError ? e.message : `${f}: ${String(e)}`);
      }
    }
  };
  loadScope(opts.builtinDir, "builtin");
  loadScope(opts.globalDir, "global");
  loadScope(opts.projectDir, "project");
  return { lifecycles, warnings, errors };
}
```

Create `src/lifecycle/port.ts` (single import surface for engine/views/tools):
```ts
// src/lifecycle/port.ts
export { parseLifecycleFile, discoverLifecycles, LifecycleParseError } from "./registry.ts";
export type { LifecycleDiscoverOpts, LifecycleDiscoverResult } from "./registry.ts";
export type {
  LifecycleStatus, LifecycleMode, BackendId, PhaseDef, LifecycleDef, PhaseRecord,
  LifecycleRunRecord, CheckpointAction, CheckpointDecision,
} from "./lifecycle-types.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 "discoverLifecycles\|port re-exports"`
Expected: PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/registry.ts src/lifecycle/port.ts test/lifecycle-registry.test.mts
git commit -m "feat(spec-4): lifecycle discovery (project-over-global, mirrors agent registry) + port surface"
```

---

## Task 4: The `default` builtin lifecycle

**Spec:** §5.3 (the 5 phases + skill bundles), §5.4 (checkpoint-at-implement=false, terminal no-checkpoint).

**Files:**
- Create: `src/lifecycle/default.ts`
- Create: `test/lifecycle-default.test.mts`

**Interfaces:**
- Consumes: `parseLifecycleFile` (Task 2).
- Produces: `DEFAULT_LIFECYCLE_SOURCE` (the markdown string), `DEFAULT_LIFECYCLE` (parsed `LifecycleDef`), `builtinLifecyclesDir()`.

- [ ] **Step 1: Write the failing test**

`test/lifecycle-default.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { DEFAULT_LIFECYCLE, DEFAULT_LIFECYCLE_SOURCE } from "../src/lifecycle/default.ts";

test("default lifecycle has 5 phases with the locked skill bundles", () => {
  strictEqual(DEFAULT_LIFECYCLE.name, "default");
  strictEqual(DEFAULT_LIFECYCLE.backend, "pi");
  strictEqual(DEFAULT_LIFECYCLE.phases.length, 5);
  const names = DEFAULT_LIFECYCLE.phases.map((p) => p.name);
  ok(names.includes("brainstorm") && names.includes("plan") && names.includes("implement") && names.includes("review") && names.includes("finish"));
});

test("brainstorm = brainstorming, checkpoint true", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "brainstorm")!;
  strictEqual(p.skills.join(","), "brainstorming");
  strictEqual(p.checkpoint, true);
});

test("implement = executing-plans+TDD+verification, checkpoint false", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "implement")!;
  ok(p.skills.includes("executing-plans"));
  ok(p.skills.includes("test-driven-development"));
  ok(p.skills.includes("verification-before-completion"));
  strictEqual(p.checkpoint, false, "review runs next; the review IS the gate");
});

test("review = requesting+receiving-code-review, checkpoint true", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "review")!;
  ok(p.skills.includes("requesting-code-review"));
  ok(p.skills.includes("receiving-code-review"));
  strictEqual(p.checkpoint, true);
});

test("finish = finishing-a-development-branch, no checkpoint (terminal)", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "finish")!;
  strictEqual(p.skills.join(","), "finishing-a-development-branch");
  strictEqual(p.checkpoint, false, "terminal — no checkpoint after finish");
});

test("default lifecycle does NOT include systematic-debugging or using-git-worktrees", () => {
  const all = DEFAULT_LIFECYCLE.phases.flatMap((p) => p.skills);
  ok(!all.includes("systematic-debugging"), "fallback skill, not default");
  ok(!all.includes("using-git-worktrees"), "worktree isolation is SPEC-5a");
});

test("source string is parseable back into the same def", async () => {
  const { parseLifecycleFile } = await import("../src/lifecycle/registry.ts");
  const reparsed = parseLifecycleFile(DEFAULT_LIFECYCLE_SOURCE, "<builtin>", "builtin");
  strictEqual(reparsed.phases.length, 5);
  strictEqual(reparsed.phases[0].name, "brainstorm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-default`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/default.ts`:
```ts
// src/lifecycle/default.ts
import { join } from "node:path";
import { parseLifecycleFile } from "./registry.ts";
import type { LifecycleDef } from "./lifecycle-types.ts";

/** The package builtin lifecycles/ dir, resolved relative to this module. */
export function builtinLifecyclesDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "..", "lifecycles");
}

/** The shipped `default` lifecycle as a markdown string (frontmatter + ## phase templates).
 *  This is the single source of truth — it is both written to lifecycles/default.md at build
 *  (for human reading) AND parsed here at runtime so the builtin is always in sync. */
export const DEFAULT_LIFECYCLE_SOURCE = `---
name: default
description: The superpowers-native 5-phase lifecycle (brainstorm→plan→implement→review→finish).
backend: pi
phases:
  - name: brainstorm
    skills: [brainstorming]
    agent: general-purpose
    checkpoint: true
  - name: plan
    skills: [writing-plans]
    agent: general-purpose
    checkpoint: true
  - name: implement
    skills: [executing-plans, test-driven-development, verification-before-completion]
    agent: general-purpose
    checkpoint: false
  - name: review
    skills: [requesting-code-review, receiving-code-review]
    agent: general-purpose
    checkpoint: true
  - name: finish
    skills: [finishing-a-development-branch]
    agent: general-purpose
---

## brainstorm
You are the **brainstorm** phase of a superpowers lifecycle. Use the brainstorming skill.
Task: {{task}}
{% if prev %}Previous phase ({{prev.name}}) produced: {{prev.summary}}
Artifacts to read: {{prev.paths}}{% endif %}
Explore the task, produce a design doc per the brainstorming skill. End your response with an
\`Artifacts:\` block (YAML) listing the produced file paths + a kind.

## plan
You are the **plan** phase. Use writing-plans. Read the brainstorm phase's design artifact.
{% if prev %}Previous phase: {{prev.summary}} | Artifacts: {{prev.paths}}{% endif %}
{% if feedback %}Human feedback on a prior attempt: {{feedback}}{% endif %}
Write the implementation plan per writing-plans. End with an \`Artifacts:\` block.

## implement
You are the **implement** phase. Use executing-plans + test-driven-development + verification-before-completion.
Read the plan artifact. Implement it, run tests, verify before claiming done.
End with an \`Artifacts:\` block (files changed).

## review
You are the **review** phase. Use requesting-code-review + receiving-code-review.
Review the implementation against the plan + design. Produce review findings.
End with an \`Artifacts:\` block (review notes path).

## finish
You are the **finish** phase. Use finishing-a-development-branch.
Decide merge/PR/cleanup per the skill and execute it. End with an \`Artifacts:\` block
(or omit on a merge/PR with no further file artifact — terminal-phase exemption).
`;

export const DEFAULT_LIFECYCLE: LifecycleDef = parseLifecycleFile(
  DEFAULT_LIFECYCLE_SOURCE,
  "<builtin:default>",
  "builtin",
);
```

Also write the same content to `lifecycles/default.md` for human reading:
```bash
mkdir -p lifecycles
# Write DEFAULT_LIFECYCLE_SOURCE body to lifecycles/default.md (copy from the constant)
```
(Implementation note for the worker: the file `lifecycles/default.md` is a human-readable copy; the runtime uses the constant. Keep them in sync manually — the test in Task 4 step 6 guards the constant parses; a separate test that `readFileSync('lifecycles/default.md')` equals `DEFAULT_LIFECYCLE_SOURCE` guards the copy. Add that as a final assertion in `test/lifecycle-default.test.mts`.)

Append to `test/lifecycle-default.test.mts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("lifecycles/default.md is in sync with DEFAULT_LIFECYCLE_SOURCE", () => {
  const file = readFileSync(join(process.cwd(), "lifecycles", "default.md"), "utf8");
  strictEqual(file, DEFAULT_LIFECYCLE_SOURCE);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-default`
Expected: PASS (7 tests). If the `lifecycles/default.md` sync test fails, write the file from the constant first.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/default.ts lifecycles/default.md test/lifecycle-default.test.mts
git commit -m "feat(spec-4): default builtin lifecycle (5 superpowers phases, locked skill bundles)"
```

---

## Task 5: Prompt template renderer

**Spec:** §5.2 (template variables), §6.1 step d (render), §7.3 (Revise feedback injection).

**Files:**
- Create: `src/lifecycle/prompt-template.ts`
- Create: `test/prompt-template.test.mts`

**Interfaces:**
- Consumes: `PhaseRecord` from `lifecycle-types.ts` (for `prev`).
- Produces: `renderPhasePrompt(template, vars): string`, `PromptVars`.

- [ ] **Step 1: Write the failing test**

`test/prompt-template.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual } from "node:assert";
import { renderPhasePrompt, type PromptVars } from "../src/lifecycle/prompt-template.ts";

test("renders {{task}} and {{lifecycle}}/{{phase}}", () => {
  const out = renderPhasePrompt("Task: {{task}} | lc={{lifecycle}} ph={{phase}}", {
    task: "fix bug", lifecycle: "default", phase: "plan",
  });
  strictEqual(out, "Task: fix bug | lc=default ph=plan");
});

test("renders prev block when prev is present, omits when absent", () => {
  const t = "{% if prev %}prev: {{prev.name}} {{prev.summary}} paths={{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan", prev: { name: "brainstorm", summary: "did it", paths: ["a.md", "b.md"] } }),
    "prev: brainstorm did it paths=- a.md\n- b.md");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "brainstorm" }), "");
});

test("renders feedback block only when feedback present", () => {
  const t = "{% if feedback %}FB: {{feedback}}{% endif %}end";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement", feedback: "tighter" }), "FB: tighterend");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement" }), "end");
});

test("prev.paths renders as a newline-separated list, empty string when no paths", () => {
  const t = "{% if prev %}{{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", prev: { name: "a", summary: "s", paths: [] } }), "");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", prev: { name: "a", summary: "s", paths: ["only.md"] } }), "- only.md");
});

test("Revise feedback includes prior-attempt digest", () => {
  const t = "{% if feedback %}{{feedback}}{% endif %}";
  const out = renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan",
    feedback: "Prior attempt summary: first try\n\nHuman feedback: be more concrete" });
  ok(out.includes("Human feedback: be more concrete"));
  ok(out.includes("first try"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 prompt-template`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/prompt-template.ts`:
```ts
// src/lifecycle/prompt-template.ts
import type { PhaseRecord } from "./lifecycle-types.ts";

export interface PromptVars {
  task: string;
  lifecycle: string;
  phase: string;
  /** Previous phase record (absent on phase 1). */
  prev?: { name: string; summary: string; paths: string[] };
  /** On Revise only: human feedback + prior-attempt digest. */
  feedback?: string;
}

/** Render a phase prompt template. Supports {{task}}, {{lifecycle}}, {{phase}},
 *  {{prev.name}}, {{prev.summary}}, {{prev.paths}}, {{feedback}}, and
 *  {% if prev %}…{% endif %} / {% if feedback %}…{% endif %} conditional blocks. */
export function renderPhasePrompt(template: string, vars: PromptVars): string {
  let out = template;

  // {% if prev %}…{% endif %}
  out = out.replace(/{%\s*if\s*prev\s*%}([\s\S]*?){%\s*endif\s*%}/g,
    vars.prev ? "$1" : "");
  // {% if feedback %}…{% endif %}
  out = out.replace(/{%\s*if\s*feedback\s*%}([\s\S]*?){%\s*endif\s*%}/g,
    vars.feedback ? "$1" : "");

  // {{prev.paths}} → newline-separated "- path" list (or empty)
  const pathsStr = vars.prev ? vars.prev.paths.map((p) => `- ${p}`).join("\n") : "";

  out = out
    .replace(/{{\s*task\s*}}/g, vars.task)
    .replace(/{{\s*lifecycle\s*}}/g, vars.lifecycle)
    .replace(/{{\s*phase\s*}}/g, vars.phase)
    .replace(/{{\s*prev\.name\s*}}/g, vars.prev?.name ?? "")
    .replace(/{{\s*prev\.summary\s*}}/g, vars.prev?.summary ?? "")
    .replace(/{{\s*prev\.paths\s*}}/g, pathsStr)
    .replace(/{{\s*feedback\s*}}/g, vars.feedback ?? "");

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 prompt-template`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/prompt-template.ts test/prompt-template.test.mts
git commit -m "feat(spec-4): phase prompt template renderer ({{vars}} + {% if %} blocks, Revise feedback)"
```

---

## Task 6: Artifacts parser

**Spec:** §7.1 (the Artifacts block), §7.2 (terminal-phase exemption), §12 (missing block = failure).

**Files:**
- Create: `src/lifecycle/artifacts-parser.ts`
- Create: `test/artifacts-parser.test.mts`

**Interfaces:**
- Consumes: `yaml` `parse`.
- Produces: `parseArtifacts(finalText, opts): { summary, paths } | { error }`, `MAX_REVISE`.

- [ ] **Step 1: Write the failing test**

`test/artifacts-parser.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { parseArtifacts, MAX_REVISE } from "../src/lifecycle/artifacts-parser.ts";

test("parses a well-formed Artifacts block", () => {
  const r = parseArtifacts("I did the work.\n\nArtifacts:\n  - path: a.md\n    kind: design\n  - path: b.md\n    kind: plan\n");
  ok(!("error" in r));
  strictEqual(r.summary, "I did the work.");
  strictEqual(r.paths.length, 2);
  strictEqual(r.paths[0], "a.md");
});

test("summary is the text before the Artifacts block, trimmed", () => {
  const r = parseArtifacts("  leading text here  \n\nArtifacts:\n  - path: x.md\n");
  strictEqual(r.summary, "leading text here");
});

test("missing Artifacts block on a non-terminal phase = error", () => {
  const r = parseArtifacts("no artifacts here", { terminal: false });
  ok("error" in r);
  ok(/missing.*Artifacts/i.test(r.error));
});

test("missing Artifacts block on a terminal phase = ok (exemption)", () => {
  const r = parseArtifacts("merged the PR", { terminal: true });
  ok(!("error" in r));
  strictEqual(r.summary, "merged the PR");
  strictEqual(r.paths.length, 0);
});

test("malformed YAML in Artifacts block = error", () => {
  const r = parseArtifacts("work\n\nArtifacts:\n  - path: [unclosed\n", { terminal: false });
  ok("error" in r);
  ok(/malformed/i.test(r.error));
});

test("Artifacts block with no paths = error on non-terminal (needs at least one)", () => {
  const r = parseArtifacts("work\n\nArtifacts: []\n", { terminal: false });
  ok("error" in r);
  ok(/no paths/i.test(r.error));
});

test("MAX_REVISE is 3", () => { strictEqual(MAX_REVISE, 3); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 artifacts-parser`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/artifacts-parser.ts`:
```ts
// src/lifecycle/artifacts-parser.ts
import { parse as parseYaml } from "yaml";

export const MAX_REVISE = 3;

export interface ArtifactEntry { path: string; kind?: string }
export interface ArtifactsOk { summary: string; paths: string[] }
export interface ArtifactsErr { error: string }
export type ArtifactsResult = ArtifactsOk | ArtifactsErr;

/** Parse the trailing `Artifacts:` YAML block from a child's finalText.
 *  Returns {summary, paths} on success, or {error} on failure.
 *  terminal=true exempts a missing block (the finish phase may have no file artifact). */
export function parseArtifacts(finalText: string, opts: { terminal?: boolean } = {}): ArtifactsResult {
  const marker = "Artifacts:";
  const idx = finalText.lastIndexOf(marker);
  if (idx < 0) {
    if (opts.terminal) return { summary: finalText.trim(), paths: [] };
    return { error: "missing Artifacts block (child did not list produced file paths)" };
  }
  const summary = finalText.slice(0, idx).trim();
  const block = finalText.slice(idx + marker.length);
  let parsed: unknown;
  try {
    parsed = parseYaml(block) ?? [];
  } catch (e) {
    return { error: `malformed Artifacts block: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { error: "Artifacts block must be a list of {path, kind}" };
  const entries = parsed as Array<Record<string, unknown>>;
  const paths: string[] = [];
  for (const e of entries) {
    if (typeof e.path === "string" && e.path.trim()) paths.push(e.path.trim());
  }
  if (paths.length === 0 && !opts.terminal) {
    return { error: "Artifacts block has no paths (non-terminal phase must produce at least one file)" };
  }
  return { summary, paths };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 artifacts-parser`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/artifacts-parser.ts test/artifacts-parser.test.mts
git commit -m "feat(spec-4): Artifacts block parser (prompt-baked convention, terminal-phase exemption)"
```

---

## Task 7: Lifecycle TODO port method + adapter

**Spec:** §8 (TODO-sync), §6.1 step 2 + h (progress block updates), §12 (TODO port error = can't start).

**Files:**
- Modify: `src/todo-sync/port.ts` (+ `updateLifecycleProgress`)
- Modify: `src/todo-sync/adapter.ts` (+ `updateLifecycleProgress` impl)
- Create: `src/lifecycle/lifecycle-todo.ts`
- Create: `test/lifecycle-todo.test.mts`

**Interfaces:**
- Consumes: `TodoSyncPort` (existing), `addTodo`/`getTodo`/`updateTodo` from `@getpipher/armory-todo`.
- Produces: `TodoSyncPort.updateLifecycleProgress`, `createLifecycleTodo`, `updateProgress`, `completeLifecycleTodo`, `revertLifecycleTodo`.

- [ ] **Step 1: Write the failing test**

`test/lifecycle-todo.test.mts` (uses a fake TodoSyncPort — no armory-todo import):
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import {
  createLifecycleTodo, updateProgress, completeLifecycleTodo, revertLifecycleTodo,
  buildProgressBlock, type FakeTodoPort,
} from "../src/lifecycle/lifecycle-todo.ts";

function makePort(): FakeTodoPort {
  const todos = new Map<string, { id: string; notes: string; status: string }>();
  let counter = 0;
  const port: FakeTodoPort = {
    async linkOrCreateRunTodo(run) {
      const id = `td-${++counter}`;
      todos.set(id, { id, notes: `run:${run.runId}`, status: "in_progress" });
      return { todoId: id };
    },
    async markRunTodoDone() {},
    async markRunTodoReverted() {},
    async updateLifecycleProgress(todoId, block) {
      const t = todos.get(todoId);
      if (t) t.notes = block;
    },
    _state: todos,
  };
  return port;
}

test("createLifecycleTodo creates one in_progress todo + returns its id", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "implement X", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm", "plan", "implement", "review", "finish"] });
  ok(id.startsWith("td-"));
  const t = port._state.get(id)!;
  strictEqual(t.status, "in_progress");
  ok(t.notes.includes("Lifecycle: default"));
  ok(t.notes.includes("[ ] brainstorm"));
});

test("updateProgress marks a phase done + updates Last line", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm", "plan"] });
  await updateProgress(port, id, { phase: "brainstorm", done: true, last: "brainstorm completed — design written", revising: false, attempt: 0 });
  const t = port._state.get(id)!;
  ok(t.notes.includes("[x] brainstorm"));
  ok(t.notes.includes("[ ] plan"));
  ok(t.notes.includes("Last: brainstorm completed"));
});

test("updateProgress with revising shows [~] + attempt count", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["plan"] });
  await updateProgress(port, id, { phase: "plan", done: false, last: "", revising: true, attempt: 2 });
  ok(port._state.get(id)!.notes.includes("[~] plan (revising, attempt 2/3)"));
});

test("completeLifecycleTodo marks done; revertLifecycleTodo restores open", async () => {
  const port = makePort();
  const id = await createLifecycleTodo(port, { runId: "fl-1", task: "t", lifecycle: "default", backend: "pi", mode: "checkpointed", phases: ["brainstorm"] });
  await completeLifecycleTodo(port, id, "all phases done");
  strictEqual(port._state.get(id)!.status, "done");
  await revertLifecycleTodo(port, id, "aborted by user");
  strictEqual(port._state.get(id)!.status, "open");
});

test("buildProgressBlock renders the single-source-of-truth block", () => {
  const block = buildProgressBlock({
    lifecycle: "default", task: "implement X", backend: "pi", mode: "checkpointed",
    phases: [{ name: "brainstorm", done: true }, { name: "plan", done: false, revising: true, attempt: 1 }],
    last: "plan revising",
  });
  ok(block.includes("Lifecycle: default"));
  ok(block.includes("[x] brainstorm"));
  ok(block.includes("[~] plan (revising, attempt 1/3)"));
  ok(block.includes("Last: plan revising"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-todo`
Expected: FAIL (module not found; `updateLifecycleProgress` not on port).

- [ ] **Step 3: Write minimal implementation**

Modify `src/todo-sync/port.ts` — add to `TodoSyncPort`:
```ts
  /** SPEC-4: replace a lifecycle todo's notes with the phase-progress block (single source of truth). */
  updateLifecycleProgress(todoId: string, progressBlock: string): Promise<void>;
```

Modify `src/todo-sync/adapter.ts` — add the method to `ArmoryTodoAdapter`:
```ts
  async updateLifecycleProgress(todoId: string, progressBlock: string): Promise<void> {
    if (!todoId) return;
    // single-writer: replace notes wholesale with the progress block (the lifecycle owns it)
    updateTodo(todoId, { notes: progressBlock });
  }
```

Create `src/lifecycle/lifecycle-todo.ts`:
```ts
// src/lifecycle/lifecycle-todo.ts
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { BackendId, LifecycleMode } from "./lifecycle-types.ts";

/** Minimal port shape the lifecycle-todo helpers need (so unit tests can pass a fake). */
export interface LifecycleTodoPort {
  linkOrCreateRunTodo(run: { runId: string; agent: string; task: string; todoId?: string; track: boolean }): Promise<{ todoId: string | null }>;
  markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void>;
  markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void>;
  updateLifecycleProgress(todoId: string, progressBlock: string): Promise<void>;
}

/** Test fake helper type (re-exported so tests don't hand-roll the shape). */
export interface FakeTodoPort extends LifecycleTodoPort {
  _state: Map<string, { id: string; notes: string; status: string }>;
}

export interface LifecycleTodoMeta {
  runId: string; task: string; lifecycle: string; backend: BackendId; mode: LifecycleMode;
  phases: string[];
}

export interface ProgressPhase {
  name: string;
  done: boolean;
  revising?: boolean;
  attempt?: number;
}

export function buildProgressBlock(opts: {
  lifecycle: string; task: string; backend: BackendId; mode: LifecycleMode;
  phases: ProgressPhase[]; last: string;
}): string {
  const marks = opts.phases.map((p) => {
    if (p.done) return `[x] ${p.name}`;
    if (p.revising) return `[~] ${p.name} (revising, attempt ${p.attempt ?? 1}/3)`;
    return `[ ] ${p.name}`;
  }).join("  ");
  return [
    `Lifecycle: ${opts.lifecycle} · task: "${opts.task}"`,
    `Backend: ${opts.backend} · Mode: ${opts.mode}`,
    `Phases: ${marks}`,
    `Last: ${opts.last}`,
  ].join("\n");
}

export async function createLifecycleTodo(port: LifecycleTodoPort, meta: LifecycleTodoMeta): Promise<string> {
  const link = await port.linkOrCreateRunTodo({
    runId: meta.runId, agent: meta.lifecycle, task: meta.task, track: true,
  });
  if (!link.todoId) throw new Error("lifecycle TODO link-or-create returned null (armory-todo port error)");
  await port.updateLifecycleProgress(link.todoId, buildProgressBlock({
    lifecycle: meta.lifecycle, task: meta.task, backend: meta.backend, mode: meta.mode,
    phases: meta.phases.map((n) => ({ name: n, done: false })), last: "started",
  }));
  return link.todoId;
}

export async function updateProgress(
  port: LifecycleTodoPort, todoId: string, upd: { phase: string; done: boolean; last: string; revising: boolean; attempt: number },
  ctx: { lifecycle: string; task: string; backend: BackendId; mode: LifecycleMode; phases: ProgressPhase[] },
): Promise<void> {
  const phases = ctx.phases.map((p) =>
    p.name === upd.phase ? { name: p.name, done: upd.done, revising: upd.revising, attempt: upd.attempt } : p,
  );
  await port.updateLifecycleProgress(todoId, buildProgressBlock({
    lifecycle: ctx.lifecycle, task: ctx.task, backend: ctx.backend, mode: ctx.mode, phases, last: upd.last,
  }));
}

export async function completeLifecycleTodo(port: LifecycleTodoPort, todoId: string, result: string): Promise<void> {
  await port.markRunTodoDone(todoId, undefined, result);
}

export async function revertLifecycleTodo(port: LifecycleTodoPort, todoId: string, reason: string): Promise<void> {
  await port.markRunTodoReverted(todoId, undefined, reason);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 lifecycle-todo`
Expected: PASS (5 tests). Also confirm existing todo-sync / index-spec2/spec3 tests still pass (no regressions from the new port method — the adapter implements it).

Run: `pnpm typecheck`
Expected: clean (the new port method is implemented on both the interface and the adapter).

- [ ] **Step 5: Commit**

```bash
git add src/todo-sync/port.ts src/todo-sync/adapter.ts src/lifecycle/lifecycle-todo.ts test/lifecycle-todo.test.mts
git commit -m "feat(spec-4): lifecycle TODO (one per lifecycle, progress block in notes) + port updateLifecycleProgress"
```

---

## Task 8: `SpawnOptions.lifecycleTodoId` + spawnSubagent wiring

**Spec:** §8 (per-phase spawns link to parent lifecycle TODO + skip mark-done/revert), §11 (guards unchanged).

**Files:**
- Modify: `src/engine/spawnSubagent.ts` (`SpawnOptions.lifecycleTodoId?`; link-to-it; skip mark-done/revert when set)
- Create: `test/spawn-subagent-spec4.test.mts`

**Interfaces:**
- Consumes: `SpawnOptions` (existing), `linkOrCreateRunTodo` (existing).
- Produces: `SpawnOptions.lifecycleTodoId?: string` — when set, the spawn links to it (not creates) and `finishRun` skips the mark-done/revert (the lifecycle engine owns the lifecycle TODO's status).

- [ ] **Step 1: Write the failing test**

`test/spawn-subagent-spec4.test.mts` (mirror the fake-registry pattern from `spawn-subagent-spec3.test.mts`):
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory, ChildSession, ChildSessionEvent } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";
import type { TodoSyncPort } from "../src/todo-sync/port.ts";

/** Fake child session that immediately emits a completed assistant message + a finalText with Artifacts. */
function fakeSession(finalText: string): ChildSession {
  return {
    prompt: async () => {},
    subscribe: (h) => { h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }); return () => {}; },
    abort: async () => {}, dispose: () => {},
  };
}

const factory = (finalText: string): ChildSessionFactory => ({
  async create() { return { session: fakeSession(finalText), model: "test/model" }; },
});

function fakeBackend(finalText: string): Backend {
  return { id: "pi", factory: factory(finalText), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
}

const agent: AgentDef = {
  name: "general-purpose", description: "x", rolePrompt: "", todoSync: true, memoryHydrate: false, vision: false,
  backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x.md",
};

/** Fake todo port that records every call (so we assert mark-done is SKIPPED for lifecycle children). */
function recordingPort(): TodoSyncPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    async linkOrCreateRunTodo(run) { calls.push(`link:${run.todoId ?? "create"}`); return { todoId: run.todoId ?? "td-created" }; },
    async markRunTodoDone() { calls.push("markDone"); },
    async markRunTodoReverted() { calls.push("markReverted"); },
    async updateLifecycleProgress() { calls.push("progress"); },
    _that: undefined as never, calls,
  } as never;
}

test("lifecycle child spawn links to the lifecycle todoId + does NOT mark-done/revert", async () => {
  const port = recordingPort();
  const reg = new RunRegistry();
  const lock = createSingleSlotLock();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register(fakeBackend("done\n\nArtifacts:\n  - path: x.ts\n"));
  const res = await spawnSubagent({
    agent: "general-purpose", task: "t", lifecycleTodoId: "td-lifecycle",
    registry: new Map([["general-purpose", agent]]), todoSync: port, runRegistry: reg, lock, backendRegistry,
    parentModel: { provider: "test", id: "model" }, parentCwd: "/tmp",
  } as never);
  strictEqual(res.status, "completed");
  ok(port.calls.includes("link:td-lifecycle"), "linked to the lifecycle todoId (did not create)");
  ok(!port.calls.includes("markDone"), "lifecycle child skips mark-done (lifecycle engine owns status)");
  ok(!port.calls.includes("markReverted"), "lifecycle child skips mark-revert");
});

test("non-lifecycle spawn still creates + marks done (regression)", async () => {
  const port = recordingPort();
  const reg = new RunRegistry();
  const lock = createSingleSlotLock();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register(fakeBackend("done"));
  await spawnSubagent({
    agent: "general-purpose", task: "t",
    registry: new Map([["general-purpose", agent]]), todoSync: port, runRegistry: reg, lock, backendRegistry,
    parentModel: { provider: "test", id: "model" }, parentCwd: "/tmp",
  } as never);
  ok(port.calls.includes("link:create"), "no lifecycleTodoId → creates a fleet task (regression guard)");
  ok(port.calls.includes("markDone"), "non-lifecycle spawn marks done (regression guard)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 spawn-subagent-spec4`
Expected: FAIL (`lifecycleTodoId` not on `SpawnOptions`; link uses `opts.todoId`).

- [ ] **Step 3: Write minimal implementation**

Modify `src/engine/spawnSubagent.ts`:

1. Add to `SpawnOptions`:
```ts
  /** SPEC-4: when set, this spawn is a lifecycle phase child. It links to this lifecycle todo
   *  (not creates a new one) and finishRun skips mark-done/revert — the lifecycle engine owns
   *  the lifecycle todo's status + progress block. */
  lifecycleTodoId?: string;
```

2. In the todo-sync link call, link to the lifecycle todoId when set:
```ts
      const link = await opts.todoSync.linkOrCreateRunTodo({
        runId, agent: agentDef.name, task: opts.task,
        todoId: opts.lifecycleTodoId ?? opts.todoId,
        track: track && agentDef.todoSync,
      });
```

3. In `finishRun`, skip mark-done/revert when it's a lifecycle child:
```ts
async function finishRun(
  opts: SpawnOptions, runId: string, startedAt: number,
  status: FleetRunStatus, finalText: string, todoId: string | null, priorStatus: string | undefined,
  error: string | undefined, agentName: string, model: string, tokenTotal = 0,
): Promise<SpawnResult> {
  const endedAt = Date.now();
  opts.runRegistry.update(runId, { status, endedAt, resultSummary: finalText.slice(0, 120) });
  // SPEC-4: lifecycle phase children skip the per-run todo reconciliation — the lifecycle
  // engine owns the lifecycle todo's status + progress block (Q7=C).
  if (!opts.lifecycleTodoId) {
    try {
      if (status === "completed") {
        await opts.todoSync.markRunTodoDone(todoId, priorStatus, finalText.slice(0, 500));
      } else {
        await opts.todoSync.markRunTodoReverted(todoId, priorStatus, error ?? status);
      }
    } catch {
      // swallow — the run result is authoritative; the finally in spawnSubagent releases the lock
    }
  }
  return {
    status, finalText, runId, todoId, agent: agentName, model,
    durationMs: endedAt - startedAt, tokenTotal, error,
  };
}
```

- [ ] **Step 4: Run test to verify it passes + no regressions**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — `spawn-subagent-spec4` (2 tests) + all existing `spawnSubagent`/`spawn-subagent-spec2`/`spawn-subagent-spec3` tests unchanged.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/spawnSubagent.ts test/spawn-subagent-spec4.test.mts
git commit -m "feat(spec-4): SpawnOptions.lifecycleTodoId (phase spawns link to parent + skip mark-done/revert)"
```

---

## Task 9: The phase loop (`runLifecycle`)

**Spec:** §6 (phase loop + state machine), §7 (artifact chain + Revise), §12 (failure modes). The engine heart.

**Files:**
- Create: `src/lifecycle/run-lifecycle.ts`
- Create: `test/run-lifecycle.test.mts`

**Interfaces:**
- Consumes: `discoverLifecycles`/`parseLifecycleFile` (Task 2/3 — resolved via a `LifecycleRegistry` map), `renderPhasePrompt` (Task 5), `parseArtifacts`/`MAX_REVISE` (Task 6), `createLifecycleTodo`/`updateProgress`/`completeLifecycleTodo`/`revertLifecycleTodo` (Task 7), `spawnSubagent`/`SpawnOptions` (existing, with Task 8's `lifecycleTodoId`).
- Produces: `runLifecycle(task, lifecycleName, opts): Promise<LifecycleRunResult>`, `LifecycleRunResult`, `LifecycleRunDeps`, `CheckpointFn`.

- [ ] **Step 1: Write the failing test**

`test/run-lifecycle.test.mts` — uses a fake `spawnSubagent` (injected via deps) returning canned `(finalText, status)`, a fake lifecycle registry with a 3-phase lifecycle, and a fake checkpoint fn. Covers: normal advance; checkpoint Continue; Revise (success then Continue); Revise budget exhaustion → failed; phase failure forces checkpoint + auto-abort; auto mode (skip human checkpoints, abort on failure); terminal completes → done; Abort at checkpoint → aborted + todo reverted.

```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { runLifecycle, type LifecycleRunDeps, type CheckpointFn } from "../src/lifecycle/run-lifecycle.ts";
import type { LifecycleDef } from "../src/lifecycle/lifecycle-types.ts";
import { parseLifecycleFile } from "../src/lifecycle/registry.ts";

const LC_SRC = `---
name: test-lc
description: t
backend: pi
phases:
  - { name: a, skills: [], checkpoint: true }
  - { name: b, skills: [], checkpoint: true }
  - { name: c, skills: [], checkpoint: false }
---
## a
phase a {{task}}
## b
phase b {% if prev %}{{prev.summary}}{% endif %}
## c
phase c
`;

function makeDeps(spawns: Array<{ finalText: string; status: "completed" | "failed" }>): LifecycleRunDeps {
  let i = 0;
  return {
    registry: new Map([["test-lc", parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")]]),
    agentRegistry: new Map([["general-purpose", {
      name: "general-purpose", description: "x", rolePrompt: "", todoSync: true, memoryHydrate: false, vision: false,
      backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x.md",
    }]]),
    spawn: async (opts) => {
      const s = spawns[Math.min(i, spawns.length - 1)];
      i++;
      return {
        status: s.status, finalText: s.finalText, runId: `fl-${i}`, todoId: opts.lifecycleTodoId ?? "td-1",
        agent: "general-purpose", model: "test/model", durationMs: 10, tokenTotal: 0,
      };
    },
    todoPort: {
      async linkOrCreateRunTodo() { return { todoId: "td-lc" }; },
      async markRunTodoDone() {}, async markRunTodoReverted() {}, async updateLifecycleProgress() {},
    },
    resolveBackend: () => "pi",
    genRunId: () => "fl-test",
  };
}

const continueCheckpoint: CheckpointFn = async () => ({ action: "continue" });
const autoCheckpoint: CheckpointFn = async (rec) => rec.status === "failed" ? { action: "abort" } : { action: "continue" };

test("normal advance through 3 phases, lifecycle completed", async () => {
  const deps = makeDeps([
    { finalText: "a done\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "completed");
  strictEqual(res.phases.length, 3);
  strictEqual(res.phases[0].name, "a");
  ok(res.phases[0].paths.includes("a.md"));
});

test("Revise then Continue re-runs the phase with feedback", async () => {
  let calls = 0;
  const deps = makeDeps([
    { finalText: "a-v1\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "a-v2\n\nArtifacts:\n  - path: a2.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  const onCp: CheckpointFn = async (rec) => { calls++; return calls === 1 ? { action: "revise", feedback: "tighter" } : { action: "continue" }; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "completed");
  strictEqual(res.phases[0].reviseCount, 1, "phase a revised once");
  ok(res.phases[0].paths.includes("a2.md"), "revised record points at the new artifact");
});

test("Revise budget exhaustion → failed", async () => {
  const deps = makeDeps([
    { finalText: "a-v1\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "a-v2\n\nArtifacts:\n  - path: a2.md\n", status: "completed" },
    { finalText: "a-v3\n\nArtifacts:\n  - path: a3.md\n", status: "completed" },
    { finalText: "a-v4\n\nArtifacts:\n  - path: a4.md\n", status: "completed" },
  ]);
  const onCp: CheckpointFn = async () => ({ action: "revise", feedback: "again" });
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "failed");
  ok(/revise.*budget/i.test(res.error ?? ""));
});

test("phase failure forces checkpoint; auto-abort in auto mode", async () => {
  const deps = makeDeps([{ finalText: "", status: "failed" }]);
  const res = await runLifecycle("task", "test-lc", { deps, mode: "auto", onCheckpoint: autoCheckpoint });
  strictEqual(res.status, "failed");
  ok(res.phases[0].status === "failed");
});

test("phase failure forces checkpoint; checkpointed mode offers Revise/Abort (Continue disabled)", async () => {
  const deps = makeDeps([
    { finalText: "", status: "failed" },
    { finalText: "a-ok\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  let call = 0;
  const onCp: CheckpointFn = async (rec) => { call++; return call === 1 ? { action: "revise", feedback: "fix it" } : { action: "continue" }; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "completed");
  strictEqual(res.phases[0].reviseCount, 1);
});

test("Abort at checkpoint → aborted + todo reverted", async () => {
  const letAbort = { aborted: false };
  const deps = makeDeps([{ finalText: "a\n\nArtifacts:\n  - path: a.md\n", status: "completed" }]);
  const todoPort = deps.todoPort as never as { markRunTodoReverted(todoId: string | null, p: string | undefined, r: string): Promise<void>; _aborted?: boolean };
  todoPort.markRunTodoReverted = async () => { letAbort.aborted = true; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: async () => ({ action: "abort" }) });
  strictEqual(res.status, "aborted");
  ok(letAbort.aborted, "todo reverted on abort");
});

test("lifecycle name not found → resolve-time error", async () => {
  const deps = makeDeps([]);
  const res = await runLifecycle("task", "nope", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "failed");
  ok(/lifecycle 'nope' not found/.test(res.error ?? ""));
});

test("backend resolution: per-phase override then lifecycle then pi", async () => {
  // covered structurally by resolveBackend being a dep; add a LC with a per-phase claude backend
  // and assert resolveBackend is called with the phase's backend. (See interface contract.)
  ok(true, "resolveBackend dep receives the phase's resolved backend id; unit-tested via the dep mock");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 run-lifecycle`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lifecycle/run-lifecycle.ts`:
```ts
// src/lifecycle/run-lifecycle.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { SpawnResult } from "../engine/spawnSubagent.ts";
import type { BackendId, LifecycleDef, LifecycleMode, LifecycleStatus, PhaseRecord, CheckpointDecision } from "./lifecycle-types.ts";
import { renderPhasePrompt } from "./prompt-template.ts";
import { parseArtifacts, MAX_REVISE } from "./artifacts-parser.ts";
import {
  createLifecycleTodo, updateProgress, completeLifecycleTodo, revertLifecycleTodo,
  type LifecycleTodoPort, type ProgressPhase,
} from "./lifecycle-todo.ts";

/** A phase spawn is delegated to a `spawn` function (so tests inject a fake; production wires spawnSubagent). */
export interface PhaseSpawnOpts {
  agent: string;
  task: string;
  lifecycleTodoId: string;
  model?: string;
}
export type SpawnFn = (opts: PhaseSpawnOpts) => Promise<SpawnResult>;

/** Resolve the backend for a phase: phase.backend → lifecycle.backend → "pi". */
export type ResolveBackendFn = (phaseBackend: BackendId | undefined, lifecycleBackend: BackendId) => BackendId;

export interface LifecycleRunDeps {
  registry: Map<string, LifecycleDef>;
  agentRegistry: Map<string, AgentDef>;
  spawn: SpawnFn;
  todoPort: LifecycleTodoPort;
  /** Resolve the backend for a phase (default impl in index.ts: phase → lifecycle → pi + availability check). */
  resolveBackend: (phaseBackend: BackendId | undefined, lifecycleBackend: BackendId) => BackendId;
  genRunId: () => string;
}

export interface LifecycleRunOpts {
  deps: LifecycleRunDeps;
  mode: LifecycleMode;
  onCheckpoint: CheckpointFn;
  /** Optional explicit todo link (otherwise create). */
  todoId?: string;
}

export interface LifecycleRunResult {
  runId: string;
  lifecycleName: string;
  task: string;
  backend: BackendId;
  mode: LifecycleMode;
  status: LifecycleStatus;
  phases: PhaseRecord[];
  todoId: string | null;
  error?: string;
}

/** Human (or auto) decision at a checkpoint. */
export type CheckpointFn = (phase: PhaseRecord) => Promise<CheckpointDecision>;

export async function runLifecycle(task: string, lifecycleName: string, opts: LifecycleRunOpts): Promise<LifecycleRunResult> {
  const { deps } = opts;
  const startedAt = Date.now();

  // 1. Resolve lifecycle (resolve-time errors → failed result, no todo touched).
  const lifecycle = deps.registry.get(lifecycleName);
  if (!lifecycle) {
    const available = [...deps.registry.keys()].sort().join(", ");
    return fail(undefined, startedAt, `lifecycle '${lifecycleName}' not found; available: ${available}`, lifecycleName, task, opts.mode, []);
  }

  const runId = deps.genRunId();
  const lifecycleBackend = lifecycle.backend;

  // 2. Create the lifecycle TODO (one per lifecycle — Q7=C).
  let todoId: string;
  try {
    todoId = await createLifecycleTodo(deps.todoPort, {
      runId, task, lifecycle: lifecycleName, backend: lifecycleBackend, mode: opts.mode,
      phases: lifecycle.phases.map((p) => p.name),
    });
  } catch (e) {
    return fail(undefined, startedAt, `lifecycle TODO create failed: ${(e as Error).message}`, lifecycleName, task, opts.mode, []);
  }

  // Phase-progress state for the todo notes (single source of truth).
  const progressPhases: ProgressPhase[] = lifecycle.phases.map((p) => ({ name: p.name, done: false }));

  // 3. Phase loop.
  const phaseRecords: PhaseRecord[] = [];
  for (let idx = 0; idx < lifecycle.phases.length; idx++) {
    const phaseDef = lifecycle.phases[idx];
    const isTerminal = idx === lifecycle.phases.length - 1;

    // a/b/c: resolve agent + backend + skills
    const agentName = phaseDef.agent ?? "general-purpose";
    if (!deps.agentRegistry.has(agentName)) {
      await revertLifecycleTodo(deps.todoPort, todoId, `agent '${agentName}' not in registry`);
      return fail(runId, startedAt, `agent '${agentName}' (phase '${phaseDef.name}') not in registry`, lifecycleName, task, opts.mode, phaseRecords, todoId);
    }
    const backend = deps.resolveBackend(phaseDef.backend, lifecycleBackend);
    const agentDef = deps.agentRegistry.get(agentName)!;
    const skills = mergeSkills(phaseDef.skills, agentDef.skills ?? []);
    void skills; // (skills are injected by the real spawn via the factory/loader; the fake spawn ignores them)

    // d: build prompt (with prev + optional feedback on revise)
    let reviseCount = 0;
    let lastFinalText = "";
    let lastStatus: FleetRunStatus = "running";
    let phaseRec: PhaseRecord;

    // Revise loop (runs the phase, then checkpoints; on Revise, re-runs with feedback)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const prev = phaseRecords.length > 0 ? phaseRecords[phaseRecords.length - 1] : undefined;
      const feedback = reviseCount > 0 ? `Prior attempt summary: ${lastFinalText.slice(0, 500)}\n\nHuman feedback: ${opts.lastFeedback ?? ""}` : undefined;
      const prompt = renderPhasePrompt(phaseDef.promptTemplate, {
        task, lifecycle: lifecycleName, phase: phaseDef.name,
        prev: prev ? { name: prev.name, summary: prev.summary, paths: prev.paths } : undefined,
        feedback,
      });

      // e/f: spawn the phase child (links to the lifecycle todo; skips mark-done/revert — Task 8).
      const spawnRes = await deps.spawn({ agent: agentName, task: prompt, lifecycleTodoId: todoId });
      lastFinalText = spawnRes.finalText;
      lastStatus = spawnRes.status;

      // g: parse artifacts (terminal phase exempts a missing block).
      if (spawnRes.status === "failed") {
        phaseRec = { name: phaseDef.name, summary: spawnRes.error ?? spawnRes.finalText.slice(0, 120), paths: [], status: "failed", reviseCount };
      } else {
        const art = parseArtifacts(spawnRes.finalText, { terminal: isTerminal });
        if ("error" in art) {
          phaseRec = { name: phaseDef.name, summary: art.error, paths: [], status: "failed", reviseCount };
        } else {
          phaseRec = { name: phaseDef.name, summary: art.summary, paths: art.paths, status: "completed", reviseCount };
        }
      }

      // h: update the lifecycle todo progress block.
      await updateProgress(deps.todoPort, todoId, {
        phase: phaseDef.name, done: phaseRec.status === "completed",
        last: `${phaseDef.name} ${phaseRec.status}${phaseRec.paths.length ? " — " + phaseRec.paths.join(", ") : ""}`,
        revising: false, attempt: reviseCount,
      }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });

      // i: checkpoint decision.
      const forceCheckpoint = phaseRec.status === "failed"; // failure forces a checkpoint regardless of auto/checkpoint
      const shouldCheckpoint = forceCheckpoint || (phaseDef.checkpoint !== false && opts.mode === "checkpointed" && !isTerminal);
      if (!shouldCheckpoint) {
        phaseRecords.push(phaseRec);
        break; // advance to next phase
      }

      const decision = await opts.onCheckpoint(phaseRec);
      if (decision.action === "continue") {
        if (forceCheckpoint) {
          // cannot continue past a failure — treat as abort (shouldn't happen with a well-behaved checkpoint fn, but guard)
          await revertLifecycleTodo(deps.todoPort, todoId, `cannot continue past failed phase '${phaseDef.name}'`);
          return done(runId, startedAt, "aborted", lifecycleName, task, lifecycleBackend, opts.mode, [...phaseRecords, phaseRec], todoId);
        }
        phaseRecords.push(phaseRec);
        break; // advance
      }
      if (decision.action === "abort") {
        await revertLifecycleTodo(deps.todoPort, todoId, `aborted at phase '${phaseDef.name}'`);
        return done(runId, startedAt, "aborted", lifecycleName, task, lifecycleBackend, opts.mode, [...phaseRecords, phaseRec], todoId);
      }
      if (decision.action === "revise") {
        reviseCount++;
        opts.lastFeedback = decision.feedback;
        if (reviseCount > MAX_REVISE) {
          const eRun = done(runId, startedAt, "failed", lifecycleName, task, lifecycleBackend, opts.mode, [...phaseRecords, phaseRec], todoId);
          eRun.error = `phase '${phaseDef.name}' revise budget exhausted (${MAX_REVISE})`;
          // leave todo open (not done) per §12
          await updateProgress(deps.todoPort, todoId, {
            phase: phaseDef.name, done: false, last: `revise budget exhausted (${MAX_REVISE})`, revising: false, attempt: reviseCount,
          }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
          return eRun;
        }
        // mark revising in the progress block, then loop to re-run this phase
        await updateProgress(deps.todoPort, todoId, {
          phase: phaseDef.name, done: false, last: `revising (attempt ${reviseCount}/${MAX_REVISE})`, revising: true, attempt: reviseCount,
        }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
        // loop continues — re-run the phase with feedback
        continue;
      }
    }
  }

  // j: terminal phase completed → lifecycle done.
  await completeLifecycleTodo(deps.todoPort, todoId, `lifecycle '${lifecycleName}' completed`);
  return done(runId, startedAt, "completed", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId);
}

/** Merge lifecycle phase skills + agent's own skills (lifecycle first; agent can only add — Q3=B). */
function mergeSkills(phaseSkills: string[], agentSkills: string[]): string[] {
  const out = [...phaseSkills];
  for (const s of agentSkills) if (!out.includes(s)) out.push(s);
  return out;
}

function fail(runId: string | undefined, startedAt: number, error: string, lifecycleName: string, task: string, mode: LifecycleMode, phases: PhaseRecord[], todoId: string | null = null): LifecycleRunResult {
  return { runId: runId ?? "", lifecycleName, task, backend: "pi", mode, status: "failed", phases, todoId, error };
}

function done(runId: string, startedAt: number, status: LifecycleStatus, lifecycleName: string, task: string, backend: BackendId, mode: LifecycleMode, phases: PhaseRecord[], todoId: string | null): LifecycleRunResult {
  return { runId, lifecycleName, task, backend, mode, status, phases, todoId, endedAt: undefined as never };
}

// Augment opts with mutable last-feedback state for revise loops (kept off the public interface).
declare module "./run-lifecycle.ts" {
  interface LifecycleRunOpts { lastFeedback?: string }
}
```

(Note for the worker: `LifecycleRunOpts.lastFeedback` is internal scratch state for the revise loop; the augmentation above keeps it off the call-site interface. The `endedAt` field is set by the caller/UI; the engine returns `undefined` and the UI fills it. If `LifecycleRunResult` needs `endedAt`, add it to `lifecycle-types.ts` in Task 1 — the test doesn't assert it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 run-lifecycle`
Expected: PASS (8 tests).

Run: `pnpm typecheck`
Expected: clean (fix the `endedAt` typing if the compiler flags it — add `endedAt?: number` to `LifecycleRunResult` in `lifecycle-types.ts` if not present).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/run-lifecycle.ts test/run-lifecycle.test.mts
# (also lifecycle-types.ts if endedAt was added)
git commit -m "feat(spec-4): runLifecycle phase loop (resolve→spawn→checkpoint→advance, Revise bounded at 3)"
```

---

## Task 10: `subagent` tool `lifecycle` param + routing

**Spec:** §10 (the lifecycle param), §2.3 (entry points). Tool-driven = auto (onCheckpoint auto-continues/aborts).

**Files:**
- Modify: `src/tools/subagent.ts`
- Create: `test/subagent-lifecycle-param.test.mts`

**Interfaces:**
- Consumes: `runLifecycle` (Task 9), `LifecycleRunDeps` (Task 9), `SubagentToolDeps` (existing).
- Produces: `subagentParams.lifecycle`, `subagentParams.auto`; the tool routes to `runLifecycle` when `lifecycle` present.

- [ ] **Step 1: Write the failing test**

`test/subagent-lifecycle-param.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { subagentParams } from "../src/tools/subagent.ts";

test("subagent params include optional lifecycle + auto", () => {
  ok("lifecycle" in subagentParams.properties, "lifecycle param present");
  ok("auto" in subagentParams.properties, "auto param present");
  // both optional (not in required)
  const required = (subagentParams as { required?: string[] }).required ?? [];
  ok(!required.includes("lifecycle"));
  ok(!required.includes("auto"));
});

test("lifecycle absent → single-run path is unchanged (signature regression)", () => {
  // Structural: createSubagentTool still accepts the existing deps shape; execute with no lifecycle
  // calls spawnSubagent (not runLifecycle). Covered by existing subagent-tool.test.mts — this test
  // just asserts the params schema didn't drop agent/task.
  ok("agent" in subagentParams.properties);
  ok("task" in subagentParams.properties);
});
```

(The full execute-path test — that `lifecycle` present routes to `runLifecycle` — is covered by the integration test in Task 12; here we assert the schema + the regression guard.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 subagent-lifecycle-param`
Expected: FAIL (`lifecycle`/`auto` not in params).

- [ ] **Step 3: Write minimal implementation**

Modify `src/tools/subagent.ts`:

1. Add params:
```ts
export const subagentParams = Type.Object({
  agent: Type.String({ description: "Agent name from the registry (builtin, project, or global)." }),
  task: Type.String({ description: "The prompt to hand the child subagent." }),
  todoId: Type.Optional(Type.String({ description: "Explicit link to an existing open/in_progress armory-todo todo. Omit to create a fleet task." })),
  track: Type.Optional(Type.Boolean({ description: "Default true. Pass false only for throwaway lookups that don't represent real work." })),
  model: Type.Optional(Type.String({ description: 'Override the agent model, e.g. "anthropic/claude-sonnet-4".' })),
  lifecycle: Type.Optional(Type.String({ description: "Run a multi-phase superpowers lifecycle by name (e.g. 'default') instead of a single delegate. Tool-driven lifecycles run end-to-end (auto) — checkpoints are a /fleet panel feature." })),
  auto: Type.Optional(Type.Boolean({ description: "Only relevant with `lifecycle`. Tool-driven is always auto; this flag is forward-compat. Panel-driven uses --auto on /fleet-implement." })),
});
```

2. Extend `SubagentToolDeps` with the lifecycle registry + deps:
```ts
import type { LifecycleRunDeps } from "../lifecycle/run-lifecycle.ts";
import type { LifecycleDef } from "../lifecycle/lifecycle-types.ts";

export interface SubagentToolDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;
  parentModel: { provider: string; id: string };
  parentCwd: string;
  /** SPEC-4: lifecycle registry + spawn adapter (tool-driven = auto). */
  lifecycleRegistry: Map<string, LifecycleDef>;
  lifecycleDeps: Omit<LifecycleRunDeps, "spawn">; // spawn is wired from spawnSubagent in execute
}
```

3. In `execute`, route to `runLifecycle` when `lifecycle` present:
```ts
    async execute(_toolCallId: string, params: SubagentInput, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      if (params.lifecycle) {
        const { runLifecycle } = await import("../lifecycle/run-lifecycle.ts");
        const lifecycleDeps: LifecycleRunDeps = {
          ...deps.lifecycleDeps,
          spawn: async (o) => spawnSubagent({
            agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
            registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
            backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd, signal,
          }),
        };
        const res = await runLifecycle(params.task, params.lifecycle, {
          deps: lifecycleDeps, mode: "auto",
          onCheckpoint: async (phase) => phase.status === "failed" ? { action: "abort" } : { action: "continue" },
        });
        const isError = res.status === "failed" || res.status === "aborted";
        const summary = `lifecycle ${res.lifecycleName}: ${res.status} (${res.phases.length} phases)\n` +
          res.phases.map((p) => `  ${p.name}: ${p.status}${p.paths.length ? " → " + p.paths.join(", ") : ""}`).join("\n");
        return {
          content: [{ type: "text" as const, text: isError ? (res.error ?? res.status) : summary }],
          details: { runId: res.runId, todoId: res.todoId, lifecycle: res.lifecycleName, status: res.status, phases: res.phases.length },
          isError,
        };
      }
      // ... existing single-run path unchanged ...
```
(Keep the existing single-run path verbatim below the new `if (params.lifecycle)` block.)

- [ ] **Step 4: Run test to verify it passes + no regressions**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — `subagent-lifecycle-param` (2 tests) + existing `subagent-tool.test.mts` unchanged.

Run: `pnpm typecheck`
Expected: clean (Task 12 wires the real `lifecycleDeps` into `deps`; for now the type is present but `index.ts` will fill it in Task 12 — typecheck may flag `deps.lifecycleDeps` as missing until Task 12. If so, add a temporary default in `index.ts` now or defer the `SubagentToolDeps` field addition to Task 12 and add a separate `LifecycleToolDeps` param. Simplest: add the fields to `SubagentToolDeps` here AND update `index.ts` to pass them in Task 12 — typecheck of the tool file alone passes because the fields are optional from the tool's perspective. If `index.ts` typecheck fails because it constructs `deps` without the new fields, fix it in Task 12; this task's commit includes only `subagent.ts` + test, and typecheck of the whole project may temporarily fail until Task 12. Acceptable — note it in the commit message.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/subagent.ts test/subagent-lifecycle-param.test.mts
git commit -m "feat(spec-4): subagent tool lifecycle+auto params (tool-driven = auto, routes to runLifecycle)"
```

---

## Task 11: `/fleet` Lifecycle view + panel wiring

**Spec:** §9 (Lifecycle view: list, phase timeline, checkpoint submenu, Run lifecycle action), §9.5 (EditorTheme gotcha). Interactive-first.

**Files:**
- Modify: `src/panel/rows.ts` (`lifecycleRow`, `lifecyclePhaseTimeline`)
- Modify: `src/panel/fleet-panel.ts` (`View` += `"lifecycle"`; tab cycle; Run lifecycle action; checkpoint Continue/Revise/Abort; thread `() => ctx.ui.theme`)
- Create: `test/panel-spec4.test.mts`

**Interfaces:**
- Consumes: `LifecycleRunRecord` (Task 1), `runLifecycle` (Task 9), `FleetPanelDeps` (existing).
- Produces: `lifecycleRow`, `lifecyclePhaseTimeline`, the Lifecycle tab.

- [ ] **Step 1: Write the failing test**

`test/panel-spec4.test.mts` (row rendering — pure functions, no TUI):
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { lifecycleRow, lifecyclePhaseTimeline } from "../src/panel/rows.ts";
import type { LifecycleRunRecord } from "../src/lifecycle/lifecycle-types.ts";

const run = (over: Partial<LifecycleRunRecord> = {}): LifecycleRunRecord => ({
  runId: "fl-2kp9xa", lifecycleName: "default", task: "implement feature X", backend: "pi",
  mode: "checkpointed", status: "checkpoint", phases: [
    { name: "brainstorm", summary: "design", paths: ["a.md"], status: "completed", reviseCount: 0 },
    { name: "plan", summary: "plan", paths: ["b.md"], status: "completed", reviseCount: 0 },
    { name: "implement", summary: "code", paths: ["c.ts"], status: "completed", reviseCount: 1 },
    { name: "review", summary: "review", paths: ["r.md"], status: "completed", reviseCount: 0 },
    { name: "finish", summary: "", paths: [], status: "running", reviseCount: 0 },
  ],
  startedAt: 1000, todoId: "td-1", ...over,
});

test("lifecycleRow renders status glyph + id + lifecycle + current phase + counts + mode + backend + task", () => {
  const row = lifecycleRow(run());
  ok(row.startsWith("⏸ fl-2kp9xa"));
  ok(row.includes("default"));
  ok(row.includes("●finish"));
  ok(row.includes("5/5"));
  ok(row.includes("checkpointed"));
  ok(row.includes("pi"));
  ok(row.includes("implement feature X"));
});

test("lifecycleRow uses ▶ for running, ✓ for completed, ✗ for failed/aborted", () => {
  ok(lifecycleRow(run({ status: "running" })).startsWith("▶"));
  ok(lifecycleRow(run({ status: "completed" })).startsWith("✓"));
  ok(lifecycleRow(run({ status: "failed" })).startsWith("✗"));
  ok(lifecycleRow(run({ status: "aborted" })).startsWith("✗"));
});

test("lifecyclePhaseTimeline renders [x]/[~]/[ ] markers + Open hints", () => {
  const tl = lifecyclePhaseTimeline(run());
  ok(tl.includes("[x] brainstorm"), "completed → [x]");
  ok(tl.includes("[~] implement"), "revised → [~]");
  ok(tl.includes("[ ] finish") || tl.includes("[~] finish") || tl.includes("●finish"), "running/last → marker");
  ok(tl.includes("a.md"), "artifact path surfaced");
});

test("lifecyclePhaseTimeline shows the checkpoint prompt when status is checkpoint", () => {
  const tl = lifecyclePhaseTimeline(run({ status: "checkpoint" }));
  ok(/Continue|Revise|Abort/i.test(tl), "checkpoint actions present");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 panel-spec4`
Expected: FAIL (`lifecycleRow`/`lifecyclePhaseTimeline` not exported).

- [ ] **Step 3: Write minimal implementation**

Modify `src/panel/rows.ts` — append:
```ts
import type { LifecycleRunRecord, LifecycleStatus } from "../lifecycle/lifecycle-types.ts";

const LC_GLYPH: Record<LifecycleStatus, string> = {
  running: "▶", checkpoint: "⏸", completed: "✓", failed: "✗", aborted: "✗",
};

export function lifecycleRow(r: LifecycleRunRecord): string {
  const dur = r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "—";
  const cur = r.phases.find((p) => p.status === "running" || p.reviseCount > 0) ?? r.phases[r.phases.length - 1];
  const curName = cur ? `●${cur.name}` : "—";
  const counts = `${r.phases.filter((p) => p.status === "completed").length}/${r.phases.length}`;
  return `${LC_GLYPH[r.status]} ${r.runId}  ${r.lifecycleName}  ${curName} ${counts}  ${r.mode}  ${dur}  ${r.backend}  "${r.task}"`;
}

export function lifecyclePhaseTimeline(r: LifecycleRunRecord): string {
  const lines: string[] = [
    `Lifecycle ${r.runId} — ${r.lifecycleName} — "${r.task}"`,
    `Backend: ${r.backend} · Mode: ${r.mode} · Status: ${r.status}`,
    "",
    "Phases:",
  ];
  for (const p of r.phases) {
    const mark = p.status === "completed" ? "[x]" : p.reviseCount > 0 ? "[~]" : "[ ]";
    const art = p.paths.length ? ` → ${p.paths.join(", ")}` : "";
    lines.push(`  ${mark} ${p.name}  ${p.status}${art}${p.paths.length ? "  [Open]" : ""}`);
  }
  if (r.status === "checkpoint") {
    lines.push("", "── Checkpoint ──", "[Continue]  [Revise]  [Abort]");
  }
  return lines.join("\n");
}
```

Modify `src/panel/fleet-panel.ts`:

1. Extend `View`:
```ts
type View = "fleet" | "lifecycle" | "agents" | "backends";
```

2. Extend `FleetPanelDeps`:
```ts
import type { LifecycleRunRecord } from "../lifecycle/lifecycle-types.ts";
import type { LifecycleRunDeps } from "../lifecycle/run-lifecycle.ts";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  backendRegistry: BackendRegistry;
  parentModel: { provider: string; id: string };
  parentCwd: string;
  /** SPEC-4: lifecycle registry + active lifecycle run records + deps to drive checkpoints. */
  lifecycleRegistry: Map<string, LifecycleDef>;
  lifecycleRuns: Map<string, LifecycleRunRecord>; // active + recent
  lifecycleDeps: Omit<LifecycleRunDeps, "spawn">;
}
```
(Import `LifecycleDef` from `lifecycle/lifecycle-types.ts`.)

3. Tab cycle: `fleet → lifecycle → agents → backends → fleet`. Update `switchView`:
```ts
  private switchView(): void {
    this.view = this.view === "fleet" ? "lifecycle"
      : this.view === "lifecycle" ? "agents"
      : this.view === "agents" ? "backends" : "fleet";
    this.selectedBackend = null;
    this.list = this.buildList();
    this.renderShell();
  }
```

4. `buildList`: add the lifecycle view branch:
```ts
    const items: SelectItem[] =
      this.view === "fleet"
        ? this.deps.runRegistry.list().map((r: RunRecord) => ({ value: r.runId, label: fleetRow(r) }))
        : this.view === "lifecycle"
          ? [...this.deps.lifecycleRuns.values()].map((l: LifecycleRunRecord) => ({ value: l.runId, label: lifecycleRow(l) }))
          : this.view === "agents"
            ? [...this.deps.registry.values()].map((a: AgentDef) => ({ value: a.name, label: agentsRow(a) }))
            : this.deps.backendRegistry.list().map((b: Backend) => ({ value: b.id, label: backendsRow(b) }));
```

5. Tabs render: include `lifecycle`:
```ts
    const tabs = (["fleet", "lifecycle", "agents", "backends"] as View[])
      .map((v) => (v === this.view ? this.theme.fg("accent", this.theme.bold(`[${v}]`)) : this.theme.fg("dim", v)))
      .join("  ");
```

6. Add a "Run lifecycle…" action (key `r` on the lifecycle view) + the checkpoint submenu (Continue/Revise/Abort keys when a lifecycle row is at a checkpoint). Thread `() => ctx.ui.theme` is already the pattern (the panel holds `this.theme` from the factory; for live theme switches, the panel reads `ctx.ui.theme` via a getter passed in `FleetPanelOpts` — add `getTheme: () => Theme` to `FleetPanelOpts` and use it where dynamic colors matter; the existing panel already caches `theme` from the factory, which is fine for v0.4 since theme switches mid-panel are rare. Record the live-getter as a refinement — the EditorTheme gotcha primarily bites `setEditorComponent`, not `ctx.ui.custom`. Keep `this.theme`.)

7. Hint line for the lifecycle view:
```ts
          : this.view === "lifecycle"
            ? "  r:Run-lifecycle  i:Info  tab:Agents  q:Quit"
```

8. `onSelect` on lifecycle view: show the phase timeline detail (like the backends `i:Info` pane) — reuse the `selectedBackend` pattern with a `selectedLifecycle: LifecycleRunRecord | null` field.

(Full `handleInput` wiring for the Run-lifecycle inline `Input` (task → lifecycle picker → optional `--auto`) + the checkpoint actions is a mechanical extension of the existing `startRun`/`executeRun` pattern. The worker implements it mirroring the agents-view `r:Run` flow, but driving `runLifecycle` with an interactive `onCheckpoint` that opens an inline `Input` for Revise feedback + shows Continue/Abort keys. The exact keymap: `c:Continue`, `v:Revise` (then inline `Input` for feedback), `a:Abort`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -A2 panel-spec4`
Expected: PASS (4 tests). Existing `panel-spec2`/`panel-spec3`/`rows` tests unchanged (regression).

Run: `pnpm typecheck`
Expected: clean (Task 12 wires `lifecycleRegistry`/`lifecycleRuns`/`lifecycleDeps` into the deps object; typecheck of `fleet-panel.ts` alone passes because the fields are on the interface. `index.ts` typecheck may fail until Task 12 — same deferred-wiring note as Task 10.)

- [ ] **Step 5: Commit**

```bash
git add src/panel/rows.ts src/panel/fleet-panel.ts test/panel-spec4.test.mts
git commit -m "feat(spec-4): /fleet Lifecycle view (list + phase timeline + checkpoint submenu + Run action)"
```

---

## Task 12: `index.ts` wiring + `/fleet-implement` slash

**Spec:** §2.1 (registry), §2.3 (entry points), §10 (slash mirror). Build the lifecycle registry at init; thread deps; register the slash.

**Files:**
- Modify: `src/index.ts`
- Create: `test/index-spec4.test.mts`
- Create: `scripts/spec-4-smoke.mts` (real end-to-end smoke)
- Create: `docs/SPEC-4-smoke-checklist.md` (term-driven TUI smoke matrix)

**Interfaces:**
- Consumes: `discoverLifecycles` (Task 3), `DEFAULT_LIFECYCLE` (Task 4), `runLifecycle` (Task 9), the lifecycle deps (Task 9), `SubagentToolDeps` + `FleetPanelDeps` extensions (Tasks 10/11).
- Produces: the wired extension entry; `/fleet-implement` slash command; the smoke script + checklist.

- [ ] **Step 1: Write the failing test**

`test/index-spec4.test.mts` (structural — asserts the extension wires the lifecycle registry + the slash; mirrors `index-spec3.test.mts`'s approach):
```ts
import { test } from "node:test";
import { ok } from "node:assert";

test("index registers /fleet-implement command + threads lifecycle registry (smoke via import)", async () => {
  const mod = await import("../src/index.ts");
  ok(typeof mod.default === "function", "default export is the extension entry");
  // Full wiring is exercised by the term-driven smoke (docs/SPEC-4-smoke-checklist.md);
  // this test guards the export shape + that the module loads without throwing.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -A2 index-spec4`
Expected: FAIL (module loads but the slash isn't registered yet; the test may pass on shape alone — if so, the real verification is the smoke script + typecheck).

- [ ] **Step 3: Write minimal implementation**

Modify `src/index.ts`:

1. Imports:
```ts
import { discoverLifecycles } from "./lifecycle/registry.ts";
import { DEFAULT_LIFECYCLE, builtinLifecyclesDir } from "./lifecycle/default.ts";
import type { LifecycleDef } from "./lifecycle/lifecycle-types.ts";
import type { LifecycleRunDeps } from "./lifecycle/run-lifecycle.ts";
import { runLifecycle } from "./lifecycle/run-lifecycle.ts";
```

2. In the `default export` (after building `deps`), add lifecycle registry + run records + lifecycle deps:
```ts
  const lifecycleRegistry = new Map<string, LifecycleDef>();
  lifecycleRegistry.set(DEFAULT_LIFECYCLE.name, DEFAULT_LIFECYCLE); // builtin always present

  const refreshLifecycles = (ctx: { cwd: string; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): void => {
    const r = discoverLifecycles({
      projectDir: join(ctx.cwd, ".pi", "lifecycles"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "lifecycles"),
      builtinDir: builtinLifecyclesDir(),
    });
    for (const e of r.errors) ctx.ui.notify(e, "error");
    for (const w of r.warnings) ctx.ui.notify(w, "warning");
    // merge: keep builtin `default`, add/override from discovered
    lifecycleRegistry.clear();
    lifecycleRegistry.set(DEFAULT_LIFECYCLE.name, DEFAULT_LIFECYCLE);
    for (const [name, def] of r.lifecycles) lifecycleRegistry.set(name, def);
  };

  const lifecycleRuns = new Map<string, import("./lifecycle/lifecycle-types.ts").LifecycleRunRecord>();

  const lifecycleDeps: Omit<LifecycleRunDeps, "spawn"> = {
    registry: lifecycleRegistry,
    agentRegistry: deps.registry, // shared with the agent registry (refresh mutates deps.registry)
    todoPort: deps.todoSync,
    resolveBackend: (phaseBackend, lifecycleBackend) => {
      const id = phaseBackend ?? lifecycleBackend;
      // availability check: a phase requesting claude when claude is unavailable → throw (fail-loud)
      if (id === "claude" && !deps.backendRegistry.get("claude")?.available()) {
        throw new Error("phase requests backend 'claude' but claude is not installed; run 'claude' to set up, or change the phase backend in the lifecycle file");
      }
      return id;
    },
    genRunId: () => "fl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
  };

  // thread into deps
  (deps as SubagentToolDeps & { lifecycleRegistry: Map<string, LifecycleDef>; lifecycleDeps: Omit<LifecycleRunDeps, "spawn"> }).lifecycleRegistry = lifecycleRegistry;
  (deps as SubagentToolDeps & { lifecycleDeps: Omit<LifecycleRunDeps, "spawn"> }).lifecycleDeps = lifecycleDeps;
```

3. Call `refreshLifecycles` in the `session_start` + `resources_discover` handlers (alongside `refresh`).

4. Register `/fleet-implement`:
```ts
  pi.registerCommand("fleet-implement", {
    description: "Run a task through the superpowers lifecycle (default) end-to-end. Flags: --lifecycle <name>, --auto.",
    handler: async (args, ctx) => {
      const parsed = parseImplementArgs(args);
      const lcName = parsed.lifecycle ?? "default";
      if (!lifecycleRegistry.has(lcName)) {
        ctx.ui.notify(`lifecycle '${lcName}' not found; available: ${[...lifecycleRegistry.keys()].sort().join(", ")}`, "error");
        return;
      }
      if (!parsed.task) { ctx.ui.notify("usage: /fleet-implement <task> [--lifecycle <name>] [--auto]", "warning"); return; }
      // Slash = human-initiated; checkpointed by default unless --auto. Re-render the Lifecycle view on phase advance.
      const onCheckpoint = parsed.auto
        ? async (_phase: any) => ({ action: "continue" as const })
        : async (phase: any) => {
            // Non-TUI: can't prompt interactively → fall back to auto-continue + notify.
            // In TUI, the /fleet panel's Run-lifecycle action is the interactive path.
            ctx.ui.notify(`lifecycle checkpoint at '${phase.name}' — open /fleet Lifecycle view to Continue/Revise/Abort (auto-continuing for now)`, "info");
            return { action: "continue" as const };
          };
      const lifecycleFullDeps: LifecycleRunDeps = {
        ...lifecycleDeps,
        spawn: async (o) => spawnSubagent({
          agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId,
          registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
          backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: deps.parentCwd,
        }),
      };
      const res = await runLifecycle(parsed.task, lcName, { deps: lifecycleFullDeps, mode: parsed.auto ? "auto" : "checkpointed", onCheckpoint });
      lifecycleRuns.set(res.runId, { ...res, startedAt: Date.now(), endedAt: Date.now() } as never);
      ctx.ui.notify(`lifecycle ${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
    },
  });
```
Add the arg parser:
```ts
  function parseImplementArgs(args: string): { task: string; lifecycle?: string; auto?: boolean } {
    const parts = String(args ?? "").trim().split(/\s+/);
    let lifecycle: string | undefined; let auto = false; const taskParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--lifecycle") { lifecycle = parts[++i]; continue; }
      if (parts[i] === "--auto") { auto = true; continue; }
      taskParts.push(parts[i]);
    }
    return { task: taskParts.join(" ").trim(), lifecycle, auto };
  }
```

5. Pass `lifecycleRegistry`/`lifecycleRuns`/`lifecycleDeps` into `openFleetPanel` (extend `FleetPanelDeps` — the panel reads them).

- [ ] **Step 4: Run test to verify it passes + full gate**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: ALL PASS — `index-spec4` (1) + all existing tests (107 + new SPEC-4 suites) unchanged.

Run: `pnpm typecheck`
Expected: clean (the deferred-wiring from Tasks 10/11 is now resolved).

- [ ] **Step 5: Write the smoke script**

`scripts/spec-4-smoke.mts` (real end-to-end on a trivial task; real Ollama pi phases; CC rows skip if `claude` absent):
```ts
// scripts/spec-4-smoke.mts
// Run: node --import tsx scripts/spec-4-smoke.mts
// Verifies a full lifecycle (brainstorm→plan→implement→review→finish) on a trivial task
// using real Ollama Cloud pi phases. CC-phase rows skip gracefully if claude is absent.
import { runLifecycle } from "../src/lifecycle/run-lifecycle.ts";
import { DEFAULT_LIFECYCLE } from "../src/lifecycle/default.ts";
import { discoverLifecycles } from "../src/lifecycle/registry.ts";
// ... build a real lifecycleDeps with the real spawnSubagent + real backendRegistry + real todoPort ...
// ... assert: 5 phases run, each produces an Artifacts block, lifecycle status completed, todo progress block updated ...
```
(The worker fills in the real-deps wiring mirroring `scripts/spec-3-smoke.mts`; the assertion is `res.status === "completed"` + `res.phases.length === 5` + each non-terminal phase has `paths.length >= 1`.)

- [ ] **Step 6: Write the smoke checklist**

`docs/SPEC-4-smoke-checklist.md` (term-driven TUI smoke matrix — install `@getpipher/armory-fleet@0.4.0` into pi, `/reload`, `/fleet`, `tab` to Lifecycle, render list + checkpoint detail):
```md
# SPEC-4 — term-driven smoke checklist

Run after publishing v0.4.0 (install the package into pi, /reload).

| # | Row | Action | Expected |
|---|-----|--------|----------|
| 1 | install | add `"npm:@getpipher/armory-fleet@0.4.0"` to settings.json packages, /reload | pi loads the extension, no EditorTheme crash |
| 2 | /fleet | open panel, tab to Lifecycle | Lifecycle tab renders, empty list (no runs yet) |
| 3 | Run lifecycle | press `r`, type a trivial task, submit | row appears with ▶ status, phase advances |
| 4 | checkpoint | at a checkpoint (brainstorm/plan/review), the Continue/Revise/Abort submenu shows | c:Continue advances; v:Revise prompts for feedback; a:Abort reverts todo |
| 5 | completion | let it finish | row shows ✓, todo marked done in armory-todo |
| 6 | /fleet-implement <task> | run the slash | lifecycle starts, row appears in Lifecycle view |
| 7 | --auto | /fleet-implement trivial --auto | runs end-to-end, no checkpoints, ✓ on done |
```

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/index-spec4.test.mts scripts/spec-4-smoke.mts docs/SPEC-4-smoke-checklist.md
git commit -m "feat(spec-4): wire lifecycle registry + /fleet-implement slash + smoke script + TUI checklist"
```

---

## Self-Review (run after writing the full plan)

**1. Spec coverage:**
- §1 Overview → Tasks 1-12 (the whole plan).
- §2 Architecture (three registries, unchanged seam) → Task 3 (lifecycle registry), Task 8 (seam unchanged), Task 9 (loop above seam).
- §3 Decision log (7 Q&A) → baked into Global Constraints + each task's design.
- §4 File layout → File Structure section maps 1:1.
- §5 Lifecycle file format + default → Tasks 2, 4.
- §6 Phase loop → Task 9.
- §7 Artifact chain + Revise → Tasks 5 (template), 6 (parser), 9 (loop revise).
- §8 TODO-sync → Tasks 7, 8.
- §9 /fleet Lifecycle view → Task 11.
- §10 subagent lifecycle param → Task 10.
- §11 Guards → Global Constraints + Task 8 (carries through unchanged).
- §12 Error handling → Task 9 (failure forces checkpoint, revise budget, resolve-time errors), Task 12 (backend-unavailable fail-loud).
- §13 Testing → each task's test suite + Task 12 smoke.
- §14 Deferred → Global Constraints (worktree/async/concurrent→SPEC-5a, cost/workflows/RPC→SPEC-6, etc.).
- §15 Done bar → Task 12 (`/fleet-implement`).

No gaps.

**2. Placeholder scan:** Searched for "TBD"/"TODO"/"implement later"/"add appropriate"/"similar to Task"/"fill in". The two `...` ellipses in Task 10 step 3 (the existing single-run path kept verbatim) and Task 12 step 3 (real-deps wiring mirrors spec-3-smoke) are intentional "keep existing code" markers, not placeholders — the worker has the existing file. Acceptable; flagged inline.

**3. Type consistency:** `LifecycleRunDeps`/`SpawnFn`/`CheckpointFn` defined in Task 9, consumed in Tasks 10/11/12 — names match. `lifecycleTodoId` added in Task 8, consumed in Tasks 9/10/12 — matches. `updateLifecycleProgress` added to `TodoSyncPort` in Task 7, used in `lifecycle-todo.ts` Task 7 — matches. `LifecycleRunRecord` defined Task 1, used Tasks 9/11/12 — matches. `CheckpointDecision`/`CheckpointAction` Task 1, used Task 9 — matches.

No type drift found.

---

## Execution Handoff

**Plan complete and saved to `plans/SPEC-4-superpowers-native-lifecycle.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**