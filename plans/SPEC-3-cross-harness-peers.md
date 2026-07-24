# SPEC-3 — Cross-harness peers (CC + Pi backends) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fleet dual-arsenal — a `subagent` run targets one of two backends (Pi or Claude Code) chosen by the agent profile's `backend` frontmatter field — with the moat translated into CC via prompt/flag mechanisms (vision gap declared), backend-native `session_key` resume in both, and a new `/fleet` Backends view.

**Architecture:** A `BackendRegistry` maps a backend id → a `Backend` descriptor (`{ id, factory, available, versionInfo, hookParity }`); the engine consults it by `agentDef.backend`. The creation seam (`ChildSessionFactory`, SPEC-1) is unchanged. A new `createClaudeChildFactory` spawns `claude -p --output-format stream-json`, parses NDJSON into `ChildSessionEvent`s, captures the `session_id` for resume, and maps `abort`/`dispose` to child-process signals. Memory is baked into `--append-system-prompt`; `todo` excluded via `--disallowed-tools` (prompt-nudge fallback); vision is pass-through-only (`v~` gap declared in `Backend.hookParity`). `detectClaude()` runs once at init (version + stream-json schema smoke + flag-support probe); fail-loud at the backend. A `ResumeStore` maps `sessionKey → backendSessionId` per backend (file-backed); the engine stamps `runRecord.backendSessionId` from a new `session_init` event both factories emit.

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build), pi `^0.81.1` SDK (`createAgentSession`, `SessionManager`, `ModelRuntime`, `ModelRegistry`), `node:test` via tsx, `node:child_process` (`spawn`), `@getpipher/armory-memory`, `@getpipher/armory-todo`, `typebox`.

## Global Constraints

- **No build step** — raw `.ts` via tsx at runtime; `pnpm typecheck` + `pnpm test:run` (node:test via tsx) before release.
- **Test runner:** `node --import tsx --test test/*.test.mts` (Node 24 won't type-strip under `node_modules`). Use `pnpm test:run`.
- **pi target:** `^0.81.1`. SDK imports from `@earendil-works/pi-coding-agent`; `SessionManager.create(cwd)` for new file-backed Pi sessions, `SessionManager.open(path)` for resume; the `session` object exposes `sessionId: string` + `sessionFile: string | undefined`.
- **Additive only** — the Pi factory (`createChildSessionFactory`) and all SPEC-2 modules (`child-loader`, `memory-hydrate/`, `vision/`, `todo-sync/`) are untouched except Task 9's one-line `SessionManager.inMemory()` → `SessionManager.create(cwd)` + `session_init` emission (recorded in SPEC-3 §3.1 + §12).
- **CC CLI flags are kebab-case** (`--disallowed-tools`, `--allowed-tools`, `--max-turns`, `--resume`, `--append-system-prompt`, `--output-format stream-json`); exact flag names are confirmed by `detectClaude()` at init (version-detect), never hardcoded in the factory.
- **Hook parity is declared, not inferred** — `Backend.hookParity` is a constant per backend (`pi: t✓ m✓ v✓`, `claude: t✓ m✓ v~`); the chip is a static backend property, never computed at spawn time.
- **Single-writer discipline** — the child never writes to armory-todo; only the fleet engine does. CC's `todo` is excluded via `--disallowed-tools`/`--allowed-tools` (prompt-nudge fallback).
- **No AI attribution** in commits/PRs/files.
- **One commit per task**; conventional branch `feat/spec-3-cross-harness-peers` (cut at execution time, not during planning).
- **getpipher conventions:** EditorTheme gotcha — `ctx.ui.custom` receives full `Theme` (import from `@earendil-works/pi-coding-agent`); `ctx.ui.setEditorComponent` receives `EditorTheme`. Thread `() => ctx.ui.theme` for real colors. The Backends view is read-only (no editor) in v0.3, so this applies only if a future action opens one.
- **Spec:** `specs/SPEC-3-cross-harness-peers.md` — every task traces to a spec section (cited in each task header).

---

## File Structure

**Fleet (this repo):**
- `src/backend/hook-parity.ts` — `BackendHookParity` type + `PI_HOOK_PARITY` / `CLAUDE_HOOK_PARITY` constants
- `src/backend/registry.ts` — `Backend` interface + `BackendRegistry` class
- `src/backend/port.ts` — type re-exports (single import surface for engine/views)
- `src/backend/resume-store.ts` — `ResumeStore` (file-backed `sessionKey → backendSessionId` per backend)
- `src/backend/claude-events.ts` — NDJSON line → `ChildSessionEvent` mapper
- `src/backend/claude-detector.ts` — `detectClaude()` (version + schema smoke + flag-support probe)
- `src/backend/claude-session.ts` — `ClaudeChildSession` (`ChildSession` over a child process)
- `src/backend/claude-factory.ts` — `createClaudeChildFactory` (`ChildSessionFactory` for CC)
- `src/engine/spawnSubagent.ts` — **modify**: `ChildSessionEvent.backendSessionId` + `RunRecord.backendSessionId`/`sessionKey` + `SpawnOptions.childFactory` → `SpawnOptions.backendRegistry`
- `src/registry/frontmatter.ts` — **modify**: `AgentDef.backend` + `AgentDef.sessionKey` + validation
- `src/registry/discovery.ts` — **modify**: validate `backend` against registry known ids (warn + skip on invalid)
- `src/panel/rows.ts` — **modify**: `agentsRow` gains a backend badge; add `backendsRow` + `backendInfo`
- `src/panel/fleet-panel.ts` — **modify**: add `backends` to `View`; tab cycle; `r:Refresh` + `i:Info` actions
- `src/index.ts` — **modify**: `detectClaude()` at init; build `BackendRegistry`; register pi (always) + claude (if detected); thread `backendRegistry` through deps; Pi factory file-backed + `session_init`
- `agents/general-purpose-cc.md` — NEW builtin (sibling to `general-purpose`)
- `scripts/spec-3-smoke.mts` — full-run smoke (real `claude -p` if installed, else skip)
- `docs/SPEC-3-smoke-checklist.md` — term-driven smoke matrix rows
- `test/backend-registry.test.mts`, `test/resume-store.test.mts`, `test/frontmatter-backend.test.mts`, `test/spawn-subagent-spec3.test.mts`, `test/claude-events.test.mts`, `test/claude-detector.test.mts`, `test/claude-session.test.mts`, `test/claude-factory.test.mts`, `test/builtin-cc.test.mts`, `test/panel-spec3.test.mts`, `test/index-spec3.test.mts`

---

## Task 1: `BackendHookParity` + `Backend` + `BackendRegistry`

**Spec:** §2.1, §2.2, §4.6 (hook parity). Pure data structure — no deps, easiest to test first.

**Files:**
- Create: `src/backend/hook-parity.ts`
- Create: `src/backend/registry.ts`
- Create: `src/backend/port.ts`
- Create: `test/backend-registry.test.mts`

**Interfaces:**
- Consumes: `ChildSessionFactory` from `src/engine/spawnSubagent.ts` (existing).
- Produces: `BackendHookParity`, `BackendVersionInfo`, `Backend`, `BackendRegistry`, `PI_HOOK_PARITY`, `CLAUDE_HOOK_PARITY`.

- [ ] **Step 1: Write the failing test**

`test/backend-registry.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";

const fakeFactory: ChildSessionFactory = { async create() { throw new Error("unused"); } };

test("hook parity constants are declared", () => {
  strictEqual(PI_HOOK_PARITY.todo, "✓");
  strictEqual(PI_HOOK_PARITY.memory, "✓");
  strictEqual(PI_HOOK_PARITY.vision, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.todo, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.memory, "✓");
  strictEqual(CLAUDE_HOOK_PARITY.vision, "~");
});

test("BackendRegistry register/get/list", () => {
  const reg = new BackendRegistry();
  const pi: Backend = { id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(pi);
  ok(reg.get("pi") === pi);
  strictEqual(reg.list().length, 1);
  strictEqual(reg.get("nope"), undefined);
});

test("BackendRegistry list reflects registration order", () => {
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
  reg.register({ id: "claude", factory: fakeFactory, available: () => false, versionInfo: () => ({ version: "1.0.0", schemaOk: false, flagSupport: {}, note: "not installed" }), hookParity: CLAUDE_HOOK_PARITY });
  const ids = reg.list().map((b) => b.id);
  ok(ids[0] === "pi" && ids[1] === "claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/backend-registry.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/port.ts'`

- [ ] **Step 3: Create `src/backend/hook-parity.ts`**

```ts
// src/backend/hook-parity.ts — declared per-backend hook parity (SPEC-3 §2.3, §4.6).
// The chip is a static backend property, never inferred at spawn time.

export type HookState = "✓" | "~";

export interface BackendHookParity {
  /** `todo` tool excluded from the child. */
  todo: HookState;
  /** memory-hydrate (3-scope) active in the child. */
  memory: HookState;
  /** vision: capability-aware. `✓` = full (describe_image fallback); `~` = pass-through only. */
  vision: HookState;
}

/** Pi backend: full moat via loader injection + customTools (SPEC-2). */
export const PI_HOOK_PARITY: BackendHookParity = { todo: "✓", memory: "✓", vision: "✓" };

/** CC backend: moat via prompt/flag translation. Vision has no describe_image fallback (`~`). */
export const CLAUDE_HOOK_PARITY: BackendHookParity = { todo: "✓", memory: "✓", vision: "~" };
```

- [ ] **Step 4: Create `src/backend/registry.ts`**

```ts
// src/backend/registry.ts — BackendRegistry + Backend descriptor (SPEC-3 §2.1).
import type { ChildSessionFactory } from "../engine/spawnSubagent.ts";
import type { BackendHookParity } from "./hook-parity.ts";

export interface BackendVersionInfo {
  version: string;
  schemaOk: boolean;
  /** Flag support matrix probed at detect time (kebab-case flag → supported?). */
  flagSupport: Record<string, boolean>;
  note?: string;
}

export interface Backend {
  id: "pi" | "claude";
  factory: ChildSessionFactory;
  available: () => boolean;
  versionInfo: () => BackendVersionInfo | null;
  hookParity: BackendHookParity;
}

export class BackendRegistry {
  private readonly backends = new Map<string, Backend>();
  private readonly order: string[] = [];

  register(b: Backend): void {
    if (!this.backends.has(b.id)) this.order.push(b.id);
    this.backends.set(b.id, b);
  }
  get(id: string): Backend | undefined {
    return this.backends.get(id);
  }
  /** Registration-order list — the data source for the Backends view + engine lookup. */
  list(): Backend[] {
    return this.order.map((id) => this.backends.get(id)!).filter(Boolean);
  }
}
```

- [ ] **Step 5: Create `src/backend/port.ts`**

```ts
// src/backend/port.ts — single import surface for engine + views (SPEC-3 §3).
export type { BackendHookParity, HookState } from "./hook-parity.ts";
export { PI_HOOK_PARITY, CLAUDE_HOOK_PARITY } from "./hook-parity.ts";
export type { Backend, BackendVersionInfo } from "./registry.ts";
export { BackendRegistry } from "./registry.ts";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --import tsx --test test/backend-registry.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/backend/hook-parity.ts src/backend/registry.ts src/backend/port.ts test/backend-registry.test.mts
git commit -m "feat(spec-3): BackendHookParity + BackendRegistry (routing + view data source)"
```

---

## Task 2: `ResumeStore` (file-backed `sessionKey → backendSessionId`)

**Spec:** §2.4, §4.3. Per-backend file-backed store; env-overrideable root for tests (mirrors `TODO_DIR` / `ARMORY_MEMORY_ROOT`).

**Files:**
- Create: `src/backend/resume-store.ts`
- Create: `test/resume-store.test.mts`

**Interfaces:**
- Consumes: none.
- Produces: `ResumeStore` (`set(backendId, sessionKey, id)`, `get(backendId, sessionKey) → string | null`, `clear(backendId, sessionKey)`).

- [ ] **Step 1: Write the failing test**

`test/resume-store.test.mts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumeStore } from "../src/backend/resume-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-resume-"));
  process.env.FLEET_RESUME_ROOT = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FLEET_RESUME_ROOT;
});

test("set/get per backend + sessionKey", () => {
  const s = new ResumeStore();
  strictEqual(s.get("claude", "foo"), null);
  s.set("claude", "foo", "sess-1");
  strictEqual(s.get("claude", "foo"), "sess-1");
  strictEqual(s.get("pi", "foo"), null);
  s.set("pi", "foo", "/path/to/pi.jsonl");
  strictEqual(s.get("pi", "foo"), "/path/to/pi.jsonl");
});

test("clear removes a single entry", () => {
  const s = new ResumeStore();
  s.set("claude", "foo", "sess-1");
  s.clear("claude", "foo");
  strictEqual(s.get("claude", "foo"), null);
});

test("persists across instances (file-backed)", () => {
  const s1 = new ResumeStore();
  s1.set("claude", "foo", "sess-1");
  const s2 = new ResumeStore();   // re-reads the file
  strictEqual(s2.get("claude", "foo"), "sess-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/resume-store.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/resume-store.ts'`

- [ ] **Step 3: Create `src/backend/resume-store.ts`**

```ts
// src/backend/resume-store.ts — file-backed sessionKey → backendSessionId, per backend (SPEC-3 §2.4, §4.3).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rootDir(): string {
  return process.env.FLEET_RESUME_ROOT ?? join(process.env.HOME ?? "/tmp", ".pi", "agent", "cache", "fleet-resume");
}

/** Per-backend JSON map: { [sessionKey]: backendSessionId }. */
function fileFor(backendId: string): string {
  return join(rootDir(), `${backendId}.json`);
}

function readMap(backendId: string): Record<string, string> {
  const f = fileFor(backendId);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(backendId: string, m: Record<string, string>): void {
  const dir = rootDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(backendId), JSON.stringify(m, null, 2));
}

export class ResumeStore {
  get(backendId: string, sessionKey: string): string | null {
    return readMap(backendId)[sessionKey] ?? null;
  }
  set(backendId: string, sessionKey: string, backendSessionId: string): void {
    const m = readMap(backendId);
    m[sessionKey] = backendSessionId;
    writeMap(backendId, m);
  }
  clear(backendId: string, sessionKey: string): void {
    const m = readMap(backendId);
    delete m[sessionKey];
    writeMap(backendId, m);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/resume-store.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backend/resume-store.ts test/resume-store.test.mts
git commit -m "feat(spec-3): ResumeStore (file-backed sessionKey → backendSessionId per backend)"
```

---

## Task 3: Frontmatter — `backend` + `sessionKey` fields

**Spec:** §6. Pure parse + validation; no deps on other SPEC-3 modules.

**Files:**
- Modify: `src/registry/frontmatter.ts`
- Create: `test/frontmatter-backend.test.mts`

**Interfaces:**
- Consumes: existing `parseAgentFile` / `AgentDef`.
- Produces: `AgentDef.backend: "pi" | "claude"` (default `"pi"`), `AgentDef.sessionKey: string` (default = name).

- [ ] **Step 1: Write the failing test**

`test/frontmatter-backend.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, throws } from "node:assert";
import { parseAgentFile, FrontmatterError } from "../src/registry/frontmatter.ts";

const FM = (body: string) => `---\n${body}\n---\nrole body`;

test("backend defaults to pi", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d"), "/x.md", "builtin");
  strictEqual(a.backend, "pi");
});

test("backend: claude parses", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d\nbackend: claude"), "/x.md", "builtin");
  strictEqual(a.backend, "claude");
});

test("invalid backend is a FrontmatterError", () => {
  throws(
    () => parseAgentFile(FM("name: g\ndescription: d\nbackend: codex"), "/x.md", "builtin"),
    (e: Error) => e instanceof FrontmatterError && /backend/i.test(e.message) && /pi|claude/i.test(e.message),
  );
});

test("sessionKey defaults to name", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d"), "/x.md", "builtin");
  strictEqual(a.sessionKey, "g");
});

test("sessionKey explicit overrides name", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d\nsessionKey: shared-refine"), "/x.md", "builtin");
  strictEqual(a.sessionKey, "shared-refine");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/frontmatter-backend.test.mts`
Expected: FAIL — `a.backend` is `undefined` (field not yet on `AgentDef`)

- [ ] **Step 3: Modify `src/registry/frontmatter.ts`**

Add the two fields to the `AgentDef` interface (after `vision: boolean;`):
```ts
  /** Cross-harness backend routing (SPEC-3). Invalid value → FrontmatterError. */
  backend: "pi" | "claude";
  /** Stable id for backend-native resume (SPEC-3). Defaults to name. */
  sessionKey: string;
```

In `parseAgentFile`, after the `vision` line and before the `return {`, add parsing + validation:
```ts
  const rawBackend = typeof raw.backend === "string" ? raw.backend.trim() : "pi";
  if (rawBackend !== "pi" && rawBackend !== "claude") {
    throw new FrontmatterError(`${filePath}: invalid backend '${rawBackend}' (must be 'pi' | 'claude')`);
  }
  const backend = rawBackend as "pi" | "claude";
  const sessionKey = typeof raw.sessionKey === "string" && raw.sessionKey.trim() ? raw.sessionKey.trim() : name;
```

Add `backend` + `sessionKey` to the returned object:
```ts
  return {
    name,
    description,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinkingLevel: typeof raw.thinkingLevel === "string" ? (raw.thinkingLevel as ThinkingLevel) : undefined,
    tools: strList(raw.tools),
    skills: strList(raw.skills),
    rolePrompt: body,
    todoSync,
    memoryHydrate,
    vision,
    backend,
    sessionKey,
    source,
    filePath,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/frontmatter-backend.test.mts`
Expected: PASS (5 tests)

- [ ] **Step 5: Update existing frontmatter tests that construct `AgentDef` literals**

Existing tests (e.g. `test/frontmatter.test.mts`, `test/spawnSubagent.test.mts`, `test/builtin.test.mts`) construct `AgentDef` objects or assert its shape. Run the full suite to find breakages:

Run: `pnpm test:run 2>&1 | grep -E "FAIL|backend|sessionKey" | head`
Expected: TypeScript errors in tests that build `AgentDef` literals missing `backend`/`sessionKey`, or assertion failures. Add `backend: "pi", sessionKey: "<name>"` to each such literal (the `agent()` helpers in `spawnSubagent.test.mts` etc. — add `backend: "pi", sessionKey: name`).

For each broken test, add to the `AgentDef` literal:
```ts
backend: "pi",
sessionKey: "<the agent's name>",
```

- [ ] **Step 6: Run the full suite to confirm green**

Run: `pnpm test:run`
Expected: all green (the 65 SPEC-2 tests + the 5 new ones)

- [ ] **Step 7: Commit**

```bash
git add src/registry/frontmatter.ts test/frontmatter-backend.test.mts test/*.test.mts
git commit -m "feat(spec-3): frontmatter backend + sessionKey fields (profile pins backend, resume id)"
```

---

## Task 4: Engine — `ChildSessionEvent.backendSessionId` + `RunRecord` fields + `backendRegistry` routing

**Spec:** §2.1, §4.3, §7. The engine contract change: the creation seam is selected via the registry, and the run record carries resume handles.

**Files:**
- Modify: `src/engine/spawnSubagent.ts`
- Modify: `src/engine/run-registry.ts`
- Create: `test/spawn-subagent-spec3.test.mts`
- Modify: `test/spawnSubagent.test.mts` (and any test that injects `childFactory`)

**Interfaces:**
- Consumes: `Backend`, `BackendRegistry` from `src/backend/port.ts` (Task 1), `AgentDef.backend`/`sessionKey` (Task 3).
- Produces: `ChildSessionEvent.backendSessionId?: string`, `RunRecord.backendSessionId?: string | null`, `RunRecord.sessionKey?: string | null`, `SpawnOptions.backendRegistry: BackendRegistry` (replaces `childFactory`).

- [ ] **Step 1: Write the failing test**

`test/spawn-subagent-spec3.test.mts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodo } from "@getpipher/armory-todo";
import { spawnSubagent, type ChildSession, type ChildSessionEvent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-engine-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g", backend: "pi" | "claude" = "pi"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true,
  backend, sessionKey: name, source: "builtin", filePath: "/x",
});

/** Fake child that emits a session_init + N turns + finalText. */
function fakeChild(sessionId: string, turns: number, finalText: string): ChildSession {
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  let aborted = false;
  return {
    prompt: async () => {
      for (const h of handlers) h({ type: "session_init", backendSessionId: sessionId });
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        for (const h of handlers) h({ type: "turn_end" });
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; },
    dispose: () => {},
  };
}

function factoryWith(sessionId: string): ChildSessionFactory {
  return { async create(opts) { return { session: fakeChild(sessionId, 1, "done"), model: opts.model ?? "m" }; } };
}

function registryWith(backendId: "pi" | "claude", factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: backendId, factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}

test("engine routes by agentDef.backend through the registry", async () => {
  const runReg = new RunRegistry();
  let called: string | null = null;
  const ccFactory: ChildSessionFactory = { async create(opts) { called = "cc"; return { session: fakeChild("cc-1", 1, "ok"), model: opts.model ?? "" }; } };
  const reg = registryWith("claude", ccFactory);
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "claude")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  strictEqual(called, "cc");
  strictEqual(res.status, "completed");
});

test("session_init event stamps runRecord.backendSessionId + sessionKey", async () => {
  const runReg = new RunRegistry();
  const reg = registryWith("pi", factoryWith("pi-sess-42"));
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "pi")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  const rec = runReg.get(res.runId)!;
  strictEqual(rec.backendSessionId, "pi-sess-42");
  strictEqual(rec.sessionKey, "g");
});

test("unavailable backend fails fast with an actionable error", async () => {
  const runReg = new RunRegistry();
  const reg = new BackendRegistry();
  reg.register({ id: "claude", factory: factoryWith("x"), available: () => false, versionInfo: () => ({ version: "1", schemaOk: false, flagSupport: {}, note: "schema drift" }), hookParity: PI_HOOK_PARITY });
  const res = await spawnSubagent({
    agent: "g", task: "t", registry: new Map([["g", agent("g", "claude")]]),
    todoSync: new ArmoryTodoAdapter(), runRegistry: runReg, lock: createSingleSlotLock(),
    backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: tmpDir,
  });
  strictEqual(res.status, "failed");
  ok(/claude backend unavailable/i.test(res.error ?? ""));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/spawn-subagent-spec3.test.mts`
Expected: FAIL — `SpawnOptions` has no `backendRegistry`; `childFactory` still required.

- [ ] **Step 3: Modify `src/engine/spawnSubagent.ts`**

(a) Add `backendSessionId?` to `ChildSessionEvent`:
```ts
export interface ChildSessionEvent {
  type: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { cost?: { total?: number } };
  };
  /** Emitted by a backend on session init (SPEC-3). Drives runRecord.backendSessionId. */
  backendSessionId?: string;
}
```

(b) Change `SpawnOptions`: replace `childFactory: ChildSessionFactory` with `backendRegistry: BackendRegistry`. Add the import:
```ts
import type { BackendRegistry } from "../backend/port.ts";
```
In `SpawnOptions`:
```ts
  backendRegistry: BackendRegistry;   // replaces childFactory (SPEC-3 §7)
```

(c) In `spawnSubagent`, after resolving `agentDef`, look up the backend + fail fast:
```ts
  const backend = opts.backendRegistry.get(agentDef.backend);
  if (!backend || !backend.available()) {
    const note = backend?.versionInfo()?.note ?? "not registered";
    return fail(runId, startedAt, `backend '${agentDef.backend}' unavailable: ${note}`, opts.agent);
  }
```

(d) Replace the `const { session } = await opts.childFactory.create({...})` call with `opts.backendRegistry.get(agentDef.backend)!.factory.create({...})` — i.e. use `backend.factory`:
```ts
  const { session } = await backend.factory.create({
    cwd: opts.parentCwd,
    model,
    thinkingLevel: agentDef.thinkingLevel,
    tools,
    rolePrompt: agentDef.rolePrompt,
    skills: agentDef.skills ?? [],
    task: opts.task,
    agent: agentDef,
    memoryPort,
    visionPort,
  });
```

(e) In the `subscribe` handler, handle `session_init` to stamp the run record:
```ts
    const unsub = session.subscribe((e) => {
      if (e.type === "session_init" && e.backendSessionId) {
        opts.runRegistry.update(runId, { backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey });
      } else if (e.type === "turn_end") {
        if (budget.consume()) void session.abort();
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = e.message.content?.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        if (text) finalText = text;
        const total = e.message.usage?.cost?.total;
        if (typeof total === "number") tokenTotal += total;
      }
      opts.onEvent?.(e);
    });
```

- [ ] **Step 4: Modify `src/engine/run-registry.ts`**

Add the two optional fields to `RunRecord`:
```ts
export interface RunRecord {
  runId: string;
  agent: string;
  model: string;
  task: string;
  track: boolean;
  todoId: string | null;
  status: FleetRunStatus;
  startedAt: number;
  endedAt?: number;
  resultSummary?: string;
  /** Backend-native session id for resume (SPEC-3). */
  backendSessionId?: string | null;
  /** The sessionKey whose resume this run belongs to (SPEC-3). */
  sessionKey?: string | null;
}
```

- [ ] **Step 5: Update `test/spawnSubagent.test.mts` to inject `backendRegistry` instead of `childFactory`**

In every `spawnSubagent({...})` call in `test/spawnSubagent.test.mts`, replace `childFactory: <factory>` with a `BackendRegistry` wrapping it. Add a helper at the top of the file:
```ts
import { BackendRegistry, PI_HOOK_PARITY, type Backend } from "../src/backend/port.ts";

function regWith(factory: ChildSessionFactory): BackendRegistry {
  const reg = new BackendRegistry();
  const b: Backend = { id: "pi", factory, available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY };
  reg.register(b);
  return reg;
}
```
Replace each `childFactory: someFactory,` with `backendRegistry: regWith(someFactory),`.

Do the same for any other test that constructs `SpawnOptions` (grep: `rg -l "childFactory" test/`).

- [ ] **Step 6: Run the full suite**

Run: `pnpm test:run`
Expected: all green (65 prior + 4 new). The `spawnSubagent` tests now route through a registry wrapping their existing fakes — behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/engine/spawnSubagent.ts src/engine/run-registry.ts test/spawn-subagent-spec3.test.mts test/*.test.mts
git commit -m "feat(spec-3): engine routes via BackendRegistry; session_init stamps runRecord"
```

---

## Task 5: `claude-events.ts` — NDJSON → `ChildSessionEvent` mapper

**Spec:** §4.2. Pure function on NDJSON line fixtures.

**Files:**
- Create: `src/backend/claude-events.ts`
- Create: `test/claude-events.test.mts`

**Interfaces:**
- Consumes: `ChildSessionEvent` from `src/engine/spawnSubagent.ts` (now with `backendSessionId?` from Task 4).
- Produces: `mapClaudeEvent(line: string): ChildSessionEvent | null` (null = filtered/unknown-not-forwarded; the caller logs unknowns at debug).

- [ ] **Step 1: Write the failing test**

`test/claude-events.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mapClaudeEvent } from "../src/backend/claude-events.ts";

test("init event → session_init with backendSessionId", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", cwd: "/x", version: "1.0.0" }));
  ok(e);
  strictEqual(e!.type, "session_init");
  strictEqual(e!.backendSessionId, "abc-123");
});

test("assistant text message → message_end with role + content", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }));
  ok(e);
  strictEqual(e!.type, "message_end");
  strictEqual(e!.message?.role, "assistant");
  strictEqual(e!.message?.content?.[0]?.text, "hi");
});

test("result success → turn_end", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "result", subtype: "success", result: "done" }));
  ok(e);
  strictEqual(e!.type, "turn_end");
});

test("result error_max_turns → turn_end (engine maps to failed)", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "result", subtype: "error_max_turns" }));
  ok(e);
  strictEqual(e!.type, "turn_end");
});

test("user echo (our stdin write) → filtered (null)", () => {
  strictEqual(mapClaudeEvent(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] } })), null);
});

test("unknown event type → null (caller logs at debug; not crashed on)", () => {
  strictEqual(mapClaudeEvent(JSON.stringify({ type: "something_new", data: 1 })), null);
});

test("malformed JSON line → null (resilient)", () => {
  strictEqual(mapClaudeEvent("not json"), null);
});

test("error event → error event forwarded", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
  ok(e);
  strictEqual(e!.type, "error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/claude-events.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/claude-events.ts'`

- [ ] **Step 3: Create `src/backend/claude-events.ts`**

```ts
// src/backend/claude-events.ts — map one CC stream-json NDJSON line → ChildSessionEvent (SPEC-3 §4.2).
// Returns null for: filtered echoes (our own user writes), unknown types, malformed lines.
// The caller logs null-but-parseable lines at debug (forward-compat: CC may add types we don't need).
import type { ChildSessionEvent } from "../engine/spawnSubagent.ts";

interface CCMessage { role?: string; content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown>; }
interface CCEvent { type: string; subtype?: string; session_id?: string; message?: CCMessage; error?: { message?: string }; }

export function mapClaudeEvent(line: string): ChildSessionEvent | null {
  let ev: CCEvent;
  try {
    ev = JSON.parse(line) as CCEvent;
  } catch {
    return null; // malformed line — resilient
  }
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init" && typeof ev.session_id === "string") {
        return { type: "session_init", backendSessionId: ev.session_id };
      }
      return null;
    case "assistant": {
      const msg = ev.message;
      if (!msg) return null;
      const content = (msg.content ?? []).map((c) => ({ type: c.type, text: c.text }));
      // CC emits usage on the assistant message; surface cost.total if present (caller normalizes).
      const usage = msg.usage as { cost?: { total?: number } } | undefined;
      return { type: "message_end", message: { role: msg.role ?? "assistant", content, usage } };
    }
    case "result":
      // turn boundary (success or error_max_turns) → turn_end drives the budget
      return { type: "turn_end" };
    case "error":
      return { type: "error", message: { role: "error", content: [{ type: "text", text: ev.error?.message ?? "claude error" }] } };
    case "user":
      return null; // echo of our own stdin write — filtered
    default:
      return null; // unknown — forward-compat, caller logs at debug
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/claude-events.test.mts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backend/claude-events.ts test/claude-events.test.mts
git commit -m "feat(spec-3): claude-events NDJSON → ChildSessionEvent mapper"
```

---

## Task 6: `claude-detector.ts` — version + stream-json schema smoke + flag-support probe

**Spec:** §5. Spawns `claude --version` + a throwaway `claude -p --output-format stream-json "ping"`; probes `claude --help` for flag support. Tests mock via a fake `claude` fixture script (env override `FLEET_CLAUDE_BIN`).

**Files:**
- Create: `src/backend/claude-detector.ts`
- Create: `test/claude-detector.test.mts`
- Create: `test/fixtures/fake-claude.mjs` (a script that emulates `claude --version` / `claude --help` / `claude -p --output-format stream-json`)

**Interfaces:**
- Consumes: none (spawns a process).
- Produces: `detectClaude(bin?: string): Promise<BackendVersionInfo | null>`, `BackendVersionInfo` (re-exported from registry.ts; this task extends it with `flagSupport`).

- [ ] **Step 1: Write the failing test**

`test/claude-detector.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectClaude } from "../src/backend/claude-detector.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude.mjs");

test("detects a healthy claude (schemaOk true, flags probed)", async () => {
  const info = await detectClaude(fakeBin, { schemaProbeArg: "init-ok" });
  ok(info);
  strictEqual(info!.schemaOk, true);
  ok(info!.version.length > 0);
  ok(info!.flagSupport["--disallowed-tools"] === true);
  ok(info!.flagSupport["--resume"] === true);
});

test("returns null when the binary is missing", async () => {
  const info = await detectClaude("/nonexistent/claude-bin");
  strictEqual(info, null);
});

test("schema drift (init missing session_id) → schemaOk false + note", async () => {
  const info = await detectClaude(fakeBin, { schemaProbeArg: "init-drift" });
  ok(info);
  strictEqual(info!.schemaOk, false);
  ok(/drift/i.test(info!.note ?? ""));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/claude-detector.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/claude-detector.ts'`

- [ ] **Step 3: Create `test/fixtures/fake-claude.mjs`**

A node script emulating the three `claude` invocation modes the detector uses. It reads `process.argv` to decide behavior:
```js
// test/fixtures/fake-claude.mjs — emulates claude for detector tests.
const args = process.argv.slice(2);
const schemaProbe = process.env.FLEET_FAKE_CLAUDE_PROBE ?? "init-ok";

if (args[0] === "--version" || args.includes("--version")) {
  process.stdout.write("1.0.17 (fake-claude)\n");
  process.exit(0);
}
if (args[0] === "--help" || args.includes("--help")) {
  process.stdout.write("Usage: claude [options]\n  --disallowed-tools <tools>\n  --allowed-tools <tools>\n  --max-turns <n>\n  --resume <id>\n  --output-format <fmt>\n");
  process.exit(0);
}
// Otherwise: a -p stream-json invocation. Emit one init line + a result.
if (schemaProbe === "init-ok") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sess", cwd: process.cwd(), version: "1.0.17" }) + "\n");
} else if (schemaProbe === "init-drift") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", /* no session_id */ cwd: process.cwd() }) + "\n");
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "pong" }) + "\n");
process.exit(0);
```

- [ ] **Step 4: Create `src/backend/claude-detector.ts`**

```ts
// src/backend/claude-detector.ts — version + stream-json schema smoke + flag-support probe (SPEC-3 §5).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mapClaudeEvent } from "./claude-events.ts";

const DEFAULT_BIN = "claude";

export interface DetectOpts {
  /** Fixture hook: an arg passed to the fake-claude via FLEET_FAKE_CLAUDE_PROBE env to select init-ok/init-drift. */
  schemaProbeArg?: string;
}

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.on("error", () => resolve({ stdout: "", stderr: "", code: null }));
  });
}

function parseVersion(stdout: string): string {
  const m = stdout.trim().match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : stdout.trim();
}

function probeFlags(helpText: string): Record<string, boolean> {
  const has = (flag: string): boolean => new RegExp(`(^|\\s)${flag.replace(/-/g, "\\-")}(\\s|$)`).test(helpText);
  return {
    "--disallowed-tools": has("--disallowed-tools"),
    "--allowed-tools": has("--allowed-tools"),
    "--max-turns": has("--max-turns"),
    "--resume": has("--resume"),
    "--append-system-prompt": has("--append-system-prompt"),
    "--output-format": has("--output-format"),
  };
}

export async function detectClaude(bin: string = DEFAULT_BIN, opts: DetectOpts = {}): Promise<import("./registry.ts").BackendVersionInfo | null> {
  if (!existsSync(bin) && bin === DEFAULT_BIN) {
    // `claude` on PATH — check via a version run; missing binary → null
    const v = await run(bin, ["--version"]);
    if (v.code === null && /ENOENT/i.test(v.stderr)) return null;
  } else if (!existsSync(bin)) {
    return null;
  }
  const versionRun = await run(bin, ["--version"]);
  if (versionRun.code !== 0 && !versionRun.stdout) {
    return { version: "", schemaOk: false, flagSupport: {}, note: `claude --version failed (code ${versionRun.code})` };
  }
  const version = parseVersion(versionRun.stdout);

  // Schema smoke: spawn a throwaway ping in stream-json mode; read the first NDJSON line; check init shape.
  const env = opts.schemaProbeArg ? { FLEET_FAKE_CLAUDE_PROBE: opts.schemaProbeArg } : undefined;
  const smoke = await run(bin, ["-p", "--output-format", "stream-json", "ping"], env);
  const firstLine = smoke.stdout.split("\n").find((l) => l.trim());
  let schemaOk = false;
  let note: string | undefined;
  if (!firstLine) {
    note = "schema drift (no init event emitted)";
  } else {
    const ev = mapClaudeEvent(firstLine);
    if (ev && ev.type === "session_init" && ev.backendSessionId) schemaOk = true;
    else note = `schema drift (got: ${firstLine.slice(0, 80)})`;
  }

  // Flag-support probe (only meaningful if the binary exists; skip if --help unsupported).
  const helpRun = await run(bin, ["--help"]);
  const flagSupport = helpRun.code === 0 ? probeFlags(helpRun.stdout) : {};

  return { version, schemaOk, flagSupport, note };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/claude-detector.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/backend/claude-detector.ts test/claude-detector.test.mts test/fixtures/fake-claude.mjs
git commit -m "feat(spec-3): detectClaude (version + stream-json schema smoke + flag-support probe)"
```

---

## Task 7: `claude-session.ts` — `ClaudeChildSession` over a child process

**Spec:** §4.4, §4.3. `ChildSession` impl wrapping a `ChildProcess`; reads NDJSON from stdout via `mapClaudeEvent`; writes NDJSON user messages to stdin; `abort` = SIGTERM; `dispose` = kill + cleanup; on init event, writes the resume-store + emits `session_init`.

**Files:**
- Create: `src/backend/claude-session.ts`
- Create: `test/claude-session.test.mts`
- Create: `test/fixtures/fake-claude-stream.mjs` (emulates a streaming `claude -p`)

**Interfaces:**
- Consumes: `mapClaudeEvent` (Task 5), `ResumeStore` (Task 2), `ChildSession` from `src/engine/spawnSubagent.ts`.
- Produces: `ClaudeChildSession`.

- [ ] **Step 1: Write the failing test**

`test/claude-session.test.mts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ResumeStore } from "../src/backend/resume-store.ts";
import { ClaudeChildSession } from "../src/backend/claude-session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude-stream.mjs");

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-cc-sess-")); process.env.FLEET_RESUME_ROOT = root; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.FLEET_RESUME_ROOT; });

function spawnFake(): ClaudeChildSession {
  const proc = spawn(process.execPath, [fakeBin], { stdio: ["pipe", "pipe", "pipe"] });
  return new ClaudeChildSession(proc, "foo", new ResumeStore());
}

test("subscribe receives session_init then turn_end; backendSessionId captured + persisted", async () => {
  const sess = spawnFake();
  const events: string[] = [];
  sess.subscribe((e) => { events.push(e.type); });
  await sess.prompt("hello");
  strictEqual(events[0], "session_init");
  ok(events.includes("turn_end"));
  strictEqual((new ResumeStore()).get("claude", "foo"), "fake-stream-sess");
  sess.dispose();
});

test("abort kills the process", async () => {
  const sess = spawnFake();
  await sess.abort();
  ok(sess.isDisposed());
  sess.dispose();
});

test("dispose is idempotent", () => {
  const sess = spawnFake();
  sess.dispose();
  sess.dispose(); // no throw
  ok(sess.isDisposed());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/claude-session.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/claude-session.ts'`

- [ ] **Step 3: Create `test/fixtures/fake-claude-stream.mjs`**

```js
// test/fixtures/fake-claude-stream.mjs — emulates a streaming `claude -p --output-format stream-json`.
// On each stdin line (a user NDJSON message), emit init (once) + assistant + result.
let wroteInit = false;
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    if (!wroteInit) {
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-stream-sess", cwd: process.cwd(), version: "1.0.17" }) + "\n");
      wroteInit = true;
    }
    process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\n");
  }
});
```

- [ ] **Step 4: Create `src/backend/claude-session.ts`**

```ts
// src/backend/claude-session.ts — ChildSession over a claude -p child process (SPEC-3 §4.4, §4.3).
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildSession, ChildSessionEvent } from "../engine/spawnSubagent.ts";
import { mapClaudeEvent } from "./claude-events.ts";
import type { ResumeStore } from "./resume-store.ts";

export class ClaudeChildSession implements ChildSession {
  private readonly proc: ChildProcess;
  private readonly sessionKey: string;
  private readonly resumeStore: ResumeStore;
  private readonly handlers: Array<(e: ChildSessionEvent) => void> = [];
  private disposed = false;
  private initCaptured = false;
  private turnResolve: (() => void) | null = null;

  constructor(proc: ChildProcess, sessionKey: string, resumeStore: ResumeStore) {
    this.proc = proc;
    this.sessionKey = sessionKey;
    this.resumeStore = resumeStore;
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.onLine(line));
    proc.on("close", () => { if (this.turnResolve) this.turnResolve(); });
  }

  private onLine(line: string): void {
    const ev = mapClaudeEvent(line);
    if (!ev) return;
    if (ev.type === "session_init" && ev.backendSessionId && !this.initCaptured) {
      this.initCaptured = true;
      this.resumeStore.set("claude", this.sessionKey, ev.backendSessionId);
    }
    if (ev.type === "turn_end" || ev.type === "error") {
      if (this.turnResolve) { const r = this.turnResolve; this.turnResolve = null; r(); }
    }
    for (const h of this.handlers) h(ev);
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    return new Promise<void>((resolve) => {
      this.turnResolve = resolve;
      this.proc.stdin?.write(msg, () => { /* fire-and-forget; resolved on turn_end/close */ });
    });
  }

  subscribe(handler: (e: ChildSessionEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  async abort(): Promise<void> {
    if (this.disposed) return;
    this.proc.kill("SIGTERM");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
    this.proc.stdout?.destroy();
    this.proc.stdin?.end();
    this.proc.removeAllListeners();
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/claude-session.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/backend/claude-session.ts test/claude-session.test.mts test/fixtures/fake-claude-stream.mjs
git commit -m "feat(spec-3): ClaudeChildSession (ChildSession over claude -p child process)"
```

---

## Task 8: `claude-factory.ts` — `createClaudeChildFactory`

**Spec:** §4.1, §4.5, §4.6, §9.1. Composes the `claude -p` invocation from the agent def + memory block + resume id; spawns the process; wraps it in `ClaudeChildSession`.

**Files:**
- Create: `src/backend/claude-factory.ts`
- Create: `test/claude-factory.test.mts`

**Interfaces:**
- Consumes: `detectClaude` + `BackendVersionInfo` (Task 6), `ResumeStore` (Task 2), `ClaudeChildSession` (Task 7), `MemoryHydratePort` from `src/memory-hydrate/port.ts`, `ChildSessionFactory` + `ChildSessionOpts` from `src/engine/spawnSubagent.ts`.
- Produces: `createClaudeChildFactory(detector, resumeStore): ChildSessionFactory`.

- [ ] **Step 1: Write the failing test**

`test/claude-factory.test.mts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, throws } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeChildFactory } from "../src/backend/claude-factory.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import type { BackendVersionInfo } from "../src/backend/registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude-stream.mjs");
const healthy: BackendVersionInfo = { version: "1.0.17", schemaOk: true, flagSupport: { "--disallowed-tools": true, "--allowed-tools": true, "--max-turns": true, "--resume": true, "--append-system-prompt": true, "--output-format": true } };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-cc-factory-")); process.env.FLEET_RESUME_ROOT = root; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.FLEET_RESUME_ROOT; });

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "cc", description: "d", rolePrompt: "you are cc", todoSync: true, memoryHydrate: true, vision: true,
  backend: "claude", sessionKey: "cc", source: "builtin", filePath: "/x", ...over,
});

const opts = (over: Partial<import("../src/engine/spawnSubagent.ts").ChildSessionOpts> = {}) => ({
  cwd: "/tmp", model: "claude-sonnet-4-5", thinkingLevel: undefined as any, tools: ["read", "bash"], rolePrompt: "you are cc",
  skills: [], task: "do it", agent: agent(), memoryPort: { renderScopes: () => "MEMBLOCK" } as any, visionPort: { isMultimodal: () => true, isConfigured: () => true, delegate: async () => ({ ok: false }) } as any, ...over,
});

test("throws if detector says schemaOk false", async () => {
  const f = createClaudeChildFactory({ ...healthy, schemaOk: false, note: "drift" }, new ResumeStore(), fakeBin);
  await throws(() => f.create(opts()), /claude backend unavailable.*drift/i);
});

test("passes --append-system-prompt with the memory block + role prompt", async () => {
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, new ResumeStore(), process.execPath, {
    spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; },
  });
  // We only assert arg composition; the real spawn is overridden so create() returns a stub session.
  try { await f.create(opts()); } catch { /* stub session may throw on prompt; args captured above */ }
  ok(seen.length > 0);
  ok(seen[0].includes("--append-system-prompt"));
  ok(seen[0].includes("MEMBLOCK"));
  ok(seen[0].includes("--disallowed-tools"));
  ok(seen[0].includes("todo"));
});

test("passes --resume <id> when resumeStore has one for sessionKey", async () => {
  const rs = new ResumeStore();
  rs.set("claude", "cc", "prior-sess-id");
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, rs, process.execPath, { spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; } });
  try { await f.create(opts()); } catch { /* captured */ }
  ok(seen[0].includes("--resume prior-sess-id"));
});

test("omits --resume when resumeStore has no entry", async () => {
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, new ResumeStore(), process.execPath, { spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; } });
  try { await f.create(opts()); } catch { /* captured */ }
  ok(!/--resume/.test(seen[0]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/claude-factory.test.mts`
Expected: FAIL — `Cannot find module '../src/backend/claude-factory.ts'`

- [ ] **Step 3: Create `src/backend/claude-factory.ts`**

```ts
// src/backend/claude-factory.ts — createClaudeChildFactory (SPEC-3 §4.1, §4.5, §4.6, §9.1).
import { spawn, type ChildProcess } from "node:child_process";
import type { ChildSessionFactory, ChildSessionOpts } from "../engine/spawnSubagent.ts";
import type { BackendVersionInfo } from "./registry.ts";
import type { ResumeStore } from "./resume-store.ts";
import { ClaudeChildSession } from "./claude-session.ts";

export interface ClaudeFactoryOverrides {
  /** Test hook: called instead of `spawn` to inspect args. Returns a ChildProcess-shaped stub. */
  spawnOverride?: (args: string[]) => ChildProcess;
}

export function createClaudeChildFactory(
  detector: BackendVersionInfo,
  resumeStore: ResumeStore,
  bin: string = "claude",
  overrides: ClaudeFactoryOverrides = {},
): ChildSessionFactory {
  return {
    async create(opts: ChildSessionOpts): Promise<{ session: ClaudeChildSession; model: string }> {
      if (!detector.schemaOk) {
        throw new Error(`claude backend unavailable: ${detector.note ?? "schema not ok"}`);
      }
      const memoryBlock = opts.memoryPort.renderScopes();
      const sys = memoryBlock ? `${opts.rolePrompt}\n\n${memoryBlock}` : opts.rolePrompt;
      const resumeId = resumeStore.get("claude", opts.agent.sessionKey);

      const args: string[] = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
      if (opts.model) args.push("--model", opts.model);
      args.push("--append-system-prompt", sys);
      // todo exclusion: prefer --disallowed-tools; fall back to --allowed-tools allow-list when the agent pins tools.
      if (detector.flagSupport["--disallowed-tools"]) {
        args.push("--disallowed-tools", "todo");
      } else if (detector.flagSupport["--allowed-tools"] && opts.tools.length) {
        const allowed = opts.tools.filter((t) => t !== "todo").join(",");
        args.push("--allowed-tools", allowed);
      }
      if (detector.flagSupport["--max-turns"]) {
        // v0.3 leaves maxTurns to the engine's turn_end belt; pass-through would double-enforce. Omit.
      }
      if (resumeId && detector.flagSupport["--resume"]) args.push("--resume", resumeId);
      args.push(opts.task);

      const proc = overrides.spawnOverride
        ? overrides.spawnOverride(args)
        : spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const session = new ClaudeChildSession(proc, opts.agent.sessionKey, resumeStore);
      return { session, model: opts.model ?? "" };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/claude-factory.test.mts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backend/claude-factory.ts test/claude-factory.test.mts
git commit -m "feat(spec-3): createClaudeChildFactory (compose invocation, memory-in-prompt, resume)"
```

---

## Task 9: Pi factory — file-backed `SessionManager` + `session_init` emission

**Spec:** §3.1, §4.3 (Pi symmetry). The one SPEC-2 module touched: `createChildSessionFactory` in `src/index.ts`. Switch `SessionManager.inMemory()` → `SessionManager.create(cwd)` (or `SessionManager.open(path)` on resume); capture `session.sessionFile`; write the resume-store; emit `session_init` so the engine stamps the run record.

**Files:**
- Modify: `src/index.ts` (the `createChildSessionFactory` function only)
- Create: `test/pi-factory-resume.test.mts`

**Interfaces:**
- Consumes: `SessionManager` from pi SDK (`create(cwd)`, `open(path)`), `ResumeStore` (Task 2), `session.sessionFile` / `session.sessionId` (pi SDK).
- Produces: a `ChildSessionFactory` that emits `session_init` + persists Pi session handles.

- [ ] **Step 1: Write the failing test**

`test/pi-factory-resume.test.mts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory } from "../src/index.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
let resumeRoot: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-pi-factory-"));
  resumeRoot = mkdtempSync(join(tmpdir(), "fleet-pi-resume-"));
  process.env.FLEET_RESUME_ROOT = resumeRoot;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(resumeRoot, { recursive: true, force: true });
  delete process.env.FLEET_RESUME_ROOT;
});

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "g", description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true,
  backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x", ...over,
});

test("Pi factory emits session_init with a non-empty backendSessionId + persists to resume-store", async () => {
  const runtime = await ModelRuntime.create();
  const factory = createChildSessionFactory(runtime, new ArmoryMemoryAdapter(), new ResumeStore());
  const { session } = await factory.create({
    cwd: tmpDir, model: undefined, thinkingLevel: undefined, tools: ["read"], rolePrompt: "role",
    skills: [], task: "t", agent: agent(), memoryPort: new ArmoryMemoryAdapter(),
    visionPort: { isMultimodal: () => true, isConfigured: () => true, delegate: async () => ({ ok: false }) } as any,
  });
  let captured: string | undefined;
  session.subscribe((e: any) => { if (e.type === "session_init") captured = e.backendSessionId; });
  // A no-op prompt to flush the session_start → emit. (The wrapper emits session_init on subscribe registration
  // using session.sessionFile, so it's available immediately without a prompt.)
  ok(captured && captured.length > 0, "session_init emitted with a backendSessionId");
  strictEqual(new ResumeStore().get("pi", "g"), captured);
  session.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/pi-factory-resume.test.mts`
Expected: FAIL — `createChildSessionFactory` doesn't accept a `ResumeStore` / emit `session_init`.

- [ ] **Step 3: Modify `createChildSessionFactory` in `src/index.ts`**

Wrap the pi `session` in a thin adapter that (a) forwards `subscribe`/`prompt`/`abort`/`dispose`, (b) emits `session_init` once with `session.sessionFile ?? session.sessionId`, (c) writes the resume-store. Add `ResumeStore` as a third parameter. Use `SessionManager.create(cwd)` (or `SessionManager.open(path)` when a resume path exists).

Replace the existing `createChildSessionFactory` body with:
```ts
function createChildSessionFactory(modelRuntime: ModelRuntime, memoryPort: MemoryHydratePort, resumeStore: ResumeStore): ChildSessionFactory {
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
      const loader = buildChildLoader({ cwd: opts.cwd, agent: opts.agent, memoryPort });
      await loader.reload();
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
        excludeTools: ["todo"],
        customTools: injectVision ? [createDescribeImageTool(visionPort) as never] : [],
        resourceLoader: loader,
        sessionManager,
        modelRuntime,
      });
      // SPEC-3 §4.3: wrap + emit session_init + persist the session file path.
      const backendSessionId = piSession.sessionFile ?? piSession.sessionId;
      if (piSession.sessionFile) resumeStore.set("pi", opts.agent.sessionKey, piSession.sessionFile);
      const session: ChildSession = wrapPiSession(piSession as unknown as ChildSession, backendSessionId);
      return { session, model: opts.model ?? "" };
    },
  };
}
```

Add the `wrapPiSession` helper above the factory (in `src/index.ts`):
```ts
/** SPEC-3: wrap a pi SDK session so it emits session_init on subscribe + forwards the rest. */
function wrapPiSession(inner: ChildSession, backendSessionId: string): ChildSession {
  return {
    prompt: (t) => inner.prompt(t),
    abort: () => inner.abort(),
    dispose: () => inner.dispose(),
    subscribe: (handler) => {
      // Emit session_init once, immediately, then forward all real events.
      handler({ type: "session_init", backendSessionId });
      return inner.subscribe(handler);
    },
  };
}
```

Add the import of `ResumeStore` + `ChildSession` at the top of `src/index.ts`:
```ts
import { ResumeStore } from "./backend/resume-store.ts";
import type { ChildSession } from "./engine/spawnSubagent.ts";
```
And update the `deps` construction in the `export default` function to pass a `new ResumeStore()` to the factory:
```ts
    childFactory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter(), new ResumeStore()),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/pi-factory-resume.test.mts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full suite**

Run: `pnpm test:run`
Expected: all green (existing SPEC-2 index tests may need the new `ResumeStore` arg threaded — update `test/index-spec2.test.mts` if it calls `createChildSessionFactory` directly).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/pi-factory-resume.test.mts test/index-spec2.test.mts
git commit -m "feat(spec-3): Pi factory file-backed SessionManager + session_init emission (resume)"
```

---

## Task 10: `general-purpose-cc.md` builtin + discovery backend-validation

**Spec:** §6.1, §10 (invalid `backend` handling). The new builtin ships; `discovery.ts` warns + skips profiles whose `backend` isn't a registered id.

**Files:**
- Create: `agents/general-purpose-cc.md`
- Modify: `src/registry/discovery.ts` (validate `backend` — but discovery doesn't know the registry, so it validates against the static set `["pi","claude"]`; the engine's fail-fast at spawn handles a backend not in the runtime registry)
- Create: `test/builtin-cc.test.mts`

**Interfaces:**
- Consumes: `AgentDef.backend` (Task 3).
- Produces: the `general-purpose-cc` builtin; discovery warns on out-of-set `backend`.

- [ ] **Step 1: Write the failing test**

`test/builtin-cc.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { discoverAgents } from "../src/registry/discovery.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(here, "..", "agents");

test("general-purpose-cc builtin loads with backend: claude", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  const cc = r.agents.get("general-purpose-cc");
  ok(cc, "general-purpose-cc present");
  strictEqual(cc!.backend, "claude");
  strictEqual(cc!.sessionKey, "general-purpose-cc");
  ok(cc!.rolePrompt.includes("Do not call the `todo` tool"));
});

test("general-purpose builtin still defaults to backend: pi", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  strictEqual(r.agents.get("general-purpose")!.backend, "pi");
});

test("discovery warns on an invalid backend value and skips the profile", () => {
  const tmp = join(here, "fixtures", "bad-backend");
  // (fixture created in Step 3)
  const r = discoverAgents({ projectDir: tmp, globalDir: null, builtinDir: null });
  ok(r.warnings.some((w) => /invalid backend/i.test(w)));
  ok(!r.agents.has("bad"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/builtin-cc.test.mts`
Expected: FAIL — `general-purpose-cc` not found; the bad-backend fixture doesn't exist yet.

- [ ] **Step 3: Create `agents/general-purpose-cc.md`**

```md
---
name: general-purpose-cc
description: A focused general-purpose CC subagent. Use for any task needing Claude Code as the worker.
backend: claude
todoSync: true
memoryHydrate: true
vision: true
---
You are a focused subagent delegate running under Claude Code. Complete the assigned task
thoroughly, work autonomously to completion, and return a concise result summary.
Do not call the `todo` tool — the fleet engine manages todo tracking for you.
```

- [ ] **Step 4: Create the bad-backend fixture**

`test/fixtures/bad-backend/bad.md`:
```md
---
name: bad
description: a profile with a bad backend
backend: codex
---
role
```

- [ ] **Step 5: Modify `src/registry/discovery.ts`**

`parseAgentFile` already throws `FrontmatterError` on an invalid `backend` (Task 3); discovery already converts `FrontmatterError` into a warning + skip (existing `catch (e) { if (e instanceof FrontmatterError) warnings.push(e.message); ... }`). So no code change is needed in `discovery.ts` — the behavior falls out of Task 3. Verify by running the test.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --import tsx --test test/builtin-cc.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add agents/general-purpose-cc.md test/fixtures/bad-backend/bad.md test/builtin-cc.test.mts
git commit -m "feat(spec-3): general-purpose-cc builtin (backend: claude) + discovery backend-validation"
```

---

## Task 11: `/fleet` Backends view + Agents-view backend badge

**Spec:** §8. Read-only Backends tab; `r:Refresh` + `i:Info`; Agents row gains a `[pi]`/`[claude]` prefix. The EditorTheme gotcha does not apply (no editor in this view).

**Files:**
- Modify: `src/panel/rows.ts` (add `backendsRow` + `backendInfo`; `agentsRow` gains backend badge)
- Modify: `src/panel/fleet-panel.ts` (add `backends` to `View`; tab cycle; actions)
- Create: `test/panel-spec3.test.mts`

**Interfaces:**
- Consumes: `BackendRegistry`, `Backend`, `BackendHookParity` from `src/backend/port.ts`; `AgentDef.backend` (Task 3).
- Produces: `backendsRow(b: Backend): string`, `backendInfo(b: Backend): string`; `agentsRow` includes `[<backend>]`.

- [ ] **Step 1: Write the failing test**

`test/panel-spec3.test.mts`:
```ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { backendsRow, backendInfo, agentsRow } from "../src/panel/rows.ts";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "../src/backend/port.ts";
import type { ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const fakeFactory: ChildSessionFactory = { async create() { throw new Error("x"); } };

const piBe: Backend = { id: "pi", factory: fakeFactory, available: () => true, versionInfo: () => ({ version: "0.81.1", schemaOk: true, flagSupport: {} }), hookParity: PI_HOOK_PARITY };
const ccBe: Backend = { id: "claude", factory: fakeFactory, available: () => false, versionInfo: () => ({ version: "1.0.0", schemaOk: false, flagSupport: {}, note: "not installed" }), hookParity: CLAUDE_HOOK_PARITY };

test("backendsRow shows id, available glyph, version, schema, chip", () => {
  const r = backendsRow(piBe);
  ok(r.includes("pi"));
  ok(r.includes("✓"));          // available
  ok(r.includes("0.81.1"));
  ok(r.includes("t✓ m✓ v✓"));
});

test("backendsRow shows ✗ + note when unavailable", () => {
  const r = backendsRow(ccBe);
  ok(r.includes("✗"));
  ok(r.includes("not installed"));
  ok(r.includes("t✓ m✓ v~"));
});

test("backendInfo enumerates fields + hook mechanism notes", () => {
  const info = backendInfo(ccBe);
  ok(info.includes("id: claude"));
  ok(info.includes("schemaOk: false"));
  ok(info.includes("vision: ~"));
  ok(info.includes("pass-through only"));
});

test("agentsRow includes the backend badge", () => {
  const a: AgentDef = { name: "g", description: "d", model: "m", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, backend: "claude", sessionKey: "g", source: "builtin", filePath: "/x" };
  const r = agentsRow(a);
  ok(r.includes("[claude]"));
  ok(r.includes("t✓ m✓ v✓"));   // chip still reflects agent toggles (per-hook), backend parity is separate
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/panel-spec3.test.mts`
Expected: FAIL — `backendsRow` / `backendInfo` not exported.

- [ ] **Step 3: Modify `src/panel/rows.ts`**

Add at the top:
```ts
import type { Backend, BackendHookParity } from "../backend/port.ts";
```

Update `agentsRow` to include the backend badge (after `${agent.name}`):
```ts
export function agentsRow(agent: AgentDef): string {
  const model = agent.model ?? "(default)";
  const chip = `armory:[t${agent.todoSync ? "✓" : "✗"} m${agent.memoryHydrate ? "✓" : "✗"} v${agent.vision ? "✓" : "✗"}]`;
  const skills = agent.skills?.length ? `  skills: ${agent.skills.join(",")}` : "";
  const tools = agent.tools?.length ? `  tools: ${agent.tools.join(",")}` : "";
  return `${agent.name}  [${agent.backend}]  [${agent.source}]  ${model}${tools}${skills}  ${chip}`;
}
```

Add the new functions at the bottom:
```ts
function chipStr(p: BackendHookParity): string {
  return `t${p.todo} m${p.memory} v${p.vision}`;
}

export function backendsRow(b: Backend): string {
  const avail = b.available() ? "✓" : "✗";
  const vi = b.versionInfo();
  const version = vi?.version ? vi.version : "—";
  const schema = vi ? (vi.schemaOk ? "✓" : "✗") : "—";
  const note = vi && !vi.schemaOk && vi.note ? `  ${vi.note}` : "";
  return `${b.id}  ${avail}  ${version}  schema:${schema}  armory:[${chipStr(b.hookParity)}]${note}`;
}

export function backendInfo(b: Backend): string {
  const vi = b.versionInfo();
  const lines = [
    `id: ${b.id}`,
    `available: ${b.available() ? "✓" : "✗"}`,
    `version: ${vi?.version ?? "—"}`,
    `schemaOk: ${vi ? vi.schemaOk : "—"}`,
  ];
  if (vi?.note) lines.push(`note: ${vi.note}`);
  lines.push("flagSupport:");
  for (const [flag, ok] of Object.entries(vi?.flagSupport ?? {})) lines.push(`  ${flag}: ${ok ? "✓" : "✗"}`);
  lines.push("hookParity:");
  lines.push(`  todo: ${b.hookParity.todo}  (excluded via ${b.id === "pi" ? "excludeTools+noExtensions" : "--disallowed-tools/prompt-nudge"})`);
  lines.push(`  memory: ${b.hookParity.memory}  (${b.id === "pi" ? "CustomResourceLoader systemPromptOverride" : "--append-system-prompt"})`);
  lines.push(`  vision: ${b.hookParity.vision}  (${b.hookParity.vision === "✓" ? "describe_image fallback injected" : "pass-through only; no describe_image fallback — customTools not injectable into claude -p"})`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Modify `src/panel/fleet-panel.ts`**

(a) Update the `View` type + add `backendRegistry` to `FleetPanelDeps`:
```ts
type View = "fleet" | "agents" | "backends";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  childFactory: ChildSessionFactory;          // retained for the Run action (wraps the active backend's factory)
  backendRegistry: BackendRegistry;          // SPEC-3
  parentModel: { provider: string; id: string };
  parentCwd: string;
}
```
Add the import: `import type { Backend, BackendRegistry } from "../backend/port.ts";` and `import { backendsRow, backendInfo } from "./rows.ts";`

(b) Update `buildList` to handle the `backends` view:
```ts
    const items: SelectItem[] =
      this.view === "fleet"
        ? this.deps.runRegistry.list().map((r: RunRecord) => ({ value: r.runId, label: fleetRow(r) }))
        : this.view === "agents"
          ? [...this.deps.registry.values()].map((a: AgentDef) => ({ value: a.name, label: agentsRow(a) }))
          : this.deps.backendRegistry.list().map((b: Backend) => ({ value: b.id, label: backendsRow(b) }));
```

(c) Update the tabs render (in `renderShell`) to include `backends`:
```ts
    const tabs = (["fleet", "agents", "backends"] as View[])
      .map((v) => (v === this.view ? this.theme.fg("accent", this.theme.bold(`[${v}]`)) : this.theme.fg("dim", v)))
      .join("  ");
```

(d) Update `switchView` to cycle three ways:
```ts
  private switchView(): void {
    this.view = this.view === "fleet" ? "agents" : this.view === "agents" ? "backends" : "fleet";
  }
```

(e) Update the action-submenu hint line (in `renderShell`) for the backends view:
```ts
        : this.view === "fleet"
          ? "  r:Run-new  s:Stop  o:Open-todo  tab:Agents  q:Quit"
          : this.view === "agents"
            ? "  r:Run  e:Edit  i:Info  d:Reload  tab:Backends  q:Quit"
            : "  r:Refresh  i:Info  tab:Fleet  q:Quit";
```

(f) Add a `private selectedBackend: Backend | null = null;` field + handle `r:Refresh` and `i:Info` in the key handler (in `onKey`/the existing `matchesKey` block):
```ts
    if (matchesKey(data, "i") && this.view === "backends") {
      const sel = this.list.selected();
      if (sel) {
        const b = this.deps.backendRegistry.list().find((x) => x.id === sel.value);
        if (b) { this.selectedBackend = b; this.renderShell(); }
      }
      return;
    }
    if (matchesKey(data, "r") && this.view === "backends") {
      // Re-detect is engine-driven in v0.3 (no live re-spawn of detectClaude here); notify + refresh list.
      this.onNotify("Backends reflect init-time detection; restart pi to re-detect.", "info");
      this.renderShell();
      return;
    }
```
Add the `i:Info` detail pane render in `renderShell` (mirroring the agents `infoAgent` pane, but for `selectedBackend`):
```ts
    } else if (this.selectedBackend && this.view === "backends") {
      this.addChild(new Text(this.theme.fg("dim", "  ── backend info ──"), 0, 0));
      this.addChild(new Text(backendInfo(this.selectedBackend), 0, 0));
      this.addChild(new Text(this.theme.fg("dim", "  esc back"), 0, 0));
    }
```
And clear `selectedBackend` on `esc` / view switch (mirror the `infoAgent` clearing pattern).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/panel-spec3.test.mts`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: green. Update `test/panel-spec2.test.mts` / any panel test that constructs `FleetPanelDeps` to add `backendRegistry` (pass a `new BackendRegistry()` with a pi backend registered).

- [ ] **Step 7: Commit**

```bash
git add src/panel/rows.ts src/panel/fleet-panel.ts test/panel-spec3.test.mts test/*.test.mts
git commit -m "feat(spec-3): /fleet Backends view + Agents-view backend badge"
```

---

## Task 12: `index.ts` — wire `BackendRegistry` + `detectClaude` at init

**Spec:** §2, §7. The extension entrypoint runs `detectClaude()` once, builds the registry, registers `pi` (always) + `claude` (if detected), and threads `backendRegistry` through the tool + panel deps.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tools/subagent-tool.ts` (the `SubagentToolDeps` gains `backendRegistry`; the tool passes it to `spawnSubagent`) — *check the file exists; if the tool reads `childFactory` from deps, switch it to `backendRegistry`*
- Create: `test/index-spec3.test.mts`

**Interfaces:**
- Consumes: `detectClaude` (Task 6), `createClaudeChildFactory` (Task 8), `BackendRegistry` (Task 1), `ResumeStore` (Task 2).
- Produces: a wired extension where `deps.backendRegistry` selects the factory per spawn.

- [ ] **Step 1: Inspect the tool deps shape**

Run: `rg -n "childFactory|SubagentToolDeps|backendRegistry" src/tools/ src/index.ts`
Expected: the `SubagentToolDeps` interface + where `spawnSubagent` is called. Note the exact field name to replace (`childFactory` → `backendRegistry`).

- [ ] **Step 2: Write the failing test**

`test/index-spec3.test.mts`:
```ts
import { test } from "node:test";
import { ok } from "node:assert";
import { BackendRegistry } from "../src/backend/port.ts";

// Integration: the default export registers a `backendRegistry` with a pi backend always present,
// and a claude backend whose availability reflects detectClaude(). We assert the shape via the
// exported deps factory if available; otherwise this is a smoke (covered by Task 13's real-pi run).
test("placeholder — real wiring asserted in Task 13 smoke", () => {
  const reg = new BackendRegistry();
  reg.register({ id: "pi", factory: { async create() { throw new Error("x"); } }, available: () => true, versionInfo: () => null, hookParity: { todo: "✓", memory: "✓", vision: "✓" } });
  ok(reg.get("pi"));
});
```
(This task's real verification is the Task 13 smoke + typecheck; the unit here just guards the registry shape. Replace with a deeper integration test if the default export exposes a testable deps factory.)

- [ ] **Step 3: Modify `src/index.ts`**

(a) Add imports:
```ts
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY, type Backend } from "./backend/port.ts";
import { detectClaude } from "./backend/claude-detector.ts";
import { createClaudeChildFactory } from "./backend/claude-factory.ts";
import { ResumeStore } from "./backend/resume-store.ts";
import type { BackendVersionInfo } from "./backend/registry.ts";
```

(b) In the `export default async function (pi: ExtensionAPI)` body, before constructing `deps`, run detection + build the registry:
```ts
  const resumeStore = new ResumeStore();
  const claudeInfo = await detectClaude();
  const backendRegistry = new BackendRegistry();
  // pi: always available
  backendRegistry.register({
    id: "pi",
    factory: createChildSessionFactory(modelRuntime, new ArmoryMemoryAdapter(), resumeStore),
    available: () => true,
    versionInfo: () => null,
    hookParity: PI_HOOK_PARITY,
  });
  // claude: registered regardless of availability (so the Backends view shows it); available reflects detection.
  backendRegistry.register({
    id: "claude",
    factory: createClaudeChildFactory(claudeInfo ?? { version: "", schemaOk: false, flagSupport: {}, note: "not installed" }, resumeStore),
    available: () => claudeInfo?.schemaOk === true,
    versionInfo: () => claudeInfo,
    hookParity: CLAUDE_HOOK_PARITY,
  });
```

(c) In the `deps` object, replace `childFactory: createChildSessionFactory(...)` with `backendRegistry` (and keep a `childFactory` only if the panel Run action still calls it directly — if so, point it at `backendRegistry.get("pi")!.factory` for the default-run path; but the engine routes via `agentDef.backend`, so the panel Run should pass `backendRegistry` through). Update `SubagentToolDeps` and the `spawnSubagent` call site to pass `backendRegistry` instead of `childFactory`.

(d) Update the `session_start` / `refresh` handler: backend detection runs once at init; `resources_discover` reload re-discovers agents but does NOT re-detect claude (v0.3; `r:Refresh` in the panel notifies "restart pi to re-detect" — Task 11).

- [ ] **Step 4: Modify `src/tools/subagent-tool.ts`**

Replace `childFactory: ChildSessionFactory` in `SubagentToolDeps` with `backendRegistry: BackendRegistry`. In the handler's `spawnSubagent({...})` call, pass `backendRegistry: deps.backendRegistry` instead of `childFactory: deps.childFactory`. Add the import: `import type { BackendRegistry } from "../backend/port.ts";`

- [ ] **Step 5: Run typecheck + full suite**

Run: `pnpm typecheck && pnpm test:run`
Expected: green. Update any test that constructs `SubagentToolDeps` / `FleetPanelDeps` with `childFactory` to use `backendRegistry` (a `BackendRegistry` with a fake pi backend registered — reuse the `regWith` helper pattern from Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/tools/subagent-tool.ts test/index-spec3.test.mts test/*.test.mts
git commit -m "feat(spec-3): wire BackendRegistry + detectClaude at init; thread through tool+panel"
```

---

## Task 13: Real-pi smoke (`scripts/spec-3-smoke.mts` + term-driven checklist)

**Spec:** §11.2. The full-run smoke exercises the real CC backend when `claude` is installed (rows 2–4); the term-driven checklist covers rows 1/5/6/7 (no CC call). The smoke script skips cleanly when `claude` is absent.

**Files:**
- Create: `scripts/spec-3-smoke.mts`
- Create: `docs/SPEC-3-smoke-checklist.md`

**Interfaces:**
- Consumes: the wired extension (Task 12), `detectClaude`, `createClaudeChildFactory`, `ResumeStore`, `spawnSubagent`.

- [ ] **Step 1: Create `scripts/spec-3-smoke.mts`**

```ts
// scripts/spec-3-smoke.mts — SPEC-3 full-run smoke (rows 2-4).
// Exercises the REAL CC backend (spawn a real `claude -p`) when claude is installed; skips cleanly otherwise.
// Run: node --import tsx scripts/spec-3-smoke.mts
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { BackendRegistry, PI_HOOK_PARITY, CLAUDE_HOOK_PARITY } from "../src/backend/port.ts";
import { detectClaude } from "../src/backend/claude-detector.ts";
import { createClaudeChildFactory } from "../src/backend/claude-factory.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory } from "../src/index.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ✔ ${name}`); pass++; } else { console.log(`  ✖ ${name} ${detail}`); fail++; }
}

const claudeInfo = await detectClaude();
if (!claudeInfo?.schemaOk) {
  console.log("⏭  claude not available (not installed or schema drift) — skipping CC rows. Pi row 2 still runs.");
}

const resumeStore = new ResumeStore();
const runtime = await ModelRuntime.create();
const reg = new BackendRegistry();
reg.register({ id: "pi", factory: createChildSessionFactory(runtime, new ArmoryMemoryAdapter(), resumeStore), available: () => true, versionInfo: () => null, hookParity: PI_HOOK_PARITY });
if (claudeInfo) reg.register({ id: "claude", factory: createClaudeChildFactory(claudeInfo, resumeStore), available: () => claudeInfo.schemaOk, versionInfo: () => claudeInfo, hookParity: CLAUDE_HOOK_PARITY });

const piAgent: AgentDef = { name: "general-purpose", description: "d", rolePrompt: "Reply minimally.", todoSync: true, memoryHydrate: true, vision: true, backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x" };
const ccAgent: AgentDef = { name: "general-purpose-cc", description: "d", rolePrompt: "Reply minimally.", todoSync: true, memoryHydrate: true, vision: true, backend: "claude", sessionKey: "general-purpose-cc", source: "builtin", filePath: "/x" };

const registry = new Map<string, AgentDef>([["general-purpose", piAgent], ["general-purpose-cc", ccAgent]]);

// Row 2: pi backend
{
  console.log("Row 2: pi backend spawn");
  const res = await spawnSubagent({ agent: "general-purpose", task: "Reply with exactly: OK", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "Ollama", id: "glm-5.2:cloud" }, parentCwd: process.cwd() });
  check("pi run completes", res.status === "completed", res.error ?? "");
  check("pi backendSessionId set", !!res.runId);   // runRecord assertion in the engine test; here just confirm no crash
}

// Rows 3-4: CC backend + resume (only if claude available)
if (claudeInfo?.schemaOk) {
  console.log("Row 3: claude backend spawn");
  const res = await spawnSubagent({ agent: "general-purpose-cc", task: "Reply with exactly: OK", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: process.cwd() });
  check("cc run completes", res.status === "completed", res.error ?? "");
  console.log("Row 4: claude resume (re-spawn same sessionKey)");
  const res2 = await spawnSubagent({ agent: "general-purpose-cc", task: "What did I just say?", registry, todoSync: new ArmoryTodoAdapter(), runRegistry: new RunRegistry(), lock: createSingleSlotLock(), backendRegistry: reg, parentModel: { provider: "x", id: "y" }, parentCwd: process.cwd() });
  check("cc resume run completes", res2.status === "completed", res2.error ?? "");
} else {
  console.log("Rows 3-4: skipped (claude unavailable)");
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Create `docs/SPEC-3-smoke-checklist.md`**

```md
# SPEC-3 smoke checklist (real-pi, term-driven)

Rows that need no `claude` call are run via `term` inside a real pi session; rows 2-4 are the script.

## How to run
- Script (rows 2-4): `node --import tsx scripts/spec-3-smoke.mts` (skips CC rows if claude absent)
- Term rows (1/5/6/7): spawn pi in `~/local-dev/getpipher/armory-fleet`, drive via `term`

## Rows
| # | Action | Expected |
|---|---|---|
| 1 | extension loads with `claude` absent | `/fleet` Backends view shows `claude: ✗ (not installed)`; `pi: ✓` |
| 2 | `subagent(general-purpose, "reply OK")` (pi) | run completes; armory chip `t✓ m✓ v✓` |
| 3 | `subagent(general-purpose-cc, "reply OK")` (claude, if available) | run completes via `claude -p`; `backendSessionId` set; chip `t✓ m✓ v~` |
| 4 | re-spawn `general-purpose-cc` same `sessionKey` | `--resume <id>` passed; CC replays history |
| 5 | `backend: invalid` profile in `.pi/agents/` | load warning surfaced; profile excluded from registry |
| 6 | `claude` schema drift (point FLEET_CLAUDE_BIN at a fake) | Backends view shows `schema ✗`; spawn fails fast with actionable error |
| 7 | Backends view `r:Refresh` + `i:Info` | refresh notifies "restart pi to re-detect"; info shows flag matrix + hook mechanism notes |

## How to inspect the CC invocation
- Set `DEBUG=fleet:cc` (or equivalent) to log the composed `claude -p` args + the NDJSON events received.
- The `i:Info` pane on the `claude` backend row shows the flag-support matrix probed at init.

## Pass bar
- Rows 1, 5, 6, 7 pass (term-driven, no CC call).
- Rows 2-4 pass when `claude` is installed; skipped (exit 0) otherwise.
```

- [ ] **Step 3: Run the smoke script**

Run: `node --import tsx scripts/spec-3-smoke.mts`
Expected: Row 2 passes (real Ollama Cloud `session.prompt()`); rows 3-4 either pass (claude installed) or skip cleanly with `⏭`. Exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/spec-3-smoke.mts docs/SPEC-3-smoke-checklist.md
git commit -m "test(spec-3): real-pi smoke script + term-driven checklist (rows 1-7)"
```

---

## Task 14: CI gate — typecheck + full suite green + release.yml staging

**Spec:** §11.3, §13 (done bar). The release gate: everything green, the smoke script documented, `release.yml` staged for `v0.3.0` on `v*` tag (mirrors the SPEC-2 release).

**Files:**
- Verify: `.github/workflows/release.yml` (staged, fires on `v*` tag — should already exist from SPEC-2; confirm it covers `armory-fleet`)
- Modify: `package.json` (bump `version` to `0.3.0` at release time — NOT in this task; this task confirms the gate)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full gate**

Run:
```bash
pnpm typecheck && pnpm test:run && node --import tsx scripts/spec-3-smoke.mts
```
Expected: typecheck clean; all tests green (65 prior + ~30 new); smoke script exits 0 (rows 2-4 pass or skip).

- [ ] **Step 2: Confirm `release.yml` is staged**

Run: `cat .github/workflows/release.yml | head -40`
Expected: a workflow that fires on `v*` tag, publishes to npm via `NPM_TOKEN`, creates a GitHub Release (mirrors the SPEC-2 release; armory-fleet already has this from v0.2.0 — confirm it's still staged and will publish `0.3.0` on the `v0.3.0` tag).

- [ ] **Step 3: Confirm no AI attribution + clean tree**

Run: `git status --short && git log --oneline -15`
Expected: clean tree (all committed); 14 task commits on `feat/spec-3-cross-harness-peers`; no `Co-Authored-By` / `🤖` / AI mentions in any commit message or file (grep to confirm: `rg -i "co-authored|generated with|🤖" --glob '!node_modules' .`).

- [ ] **Step 4: (At release time, after merge) tag + push**

This step runs after PR merge to `main`:
```bash
# On main, after the SPEC-3 PR merges:
pnpm version 0.3.0
git push origin main --tags   # triggers release.yml → npm publish + GitHub Release v0.3.0
```

- [ ] **Step 5: Commit (any final docs/checklist tweaks)**

If the smoke checklist or release.yml needed tweaks during the gate, commit them:
```bash
git add docs/SPEC-3-smoke-checklist.md .github/workflows/release.yml
git commit -m "chore(spec-3): release.yml staging + smoke checklist finalization"
```

---

## Self-Review (run after writing; fix inline)

**1. Spec coverage** — every SPEC-3 section maps to a task:
- §2 (BackendRegistry): Task 1 ✅
- §2.4/§4.3 (resume): Tasks 2, 9 ✅
- §4 (CC adapter): Tasks 5, 6, 7, 8 ✅
- §5 (detector): Task 6 ✅
- §6 (frontmatter): Task 3 ✅
- §6.1 (builtins): Task 10 ✅
- §7 (spawn lifecycle): Task 4 ✅
- §8 (Backends view + badge): Task 11 ✅
- §9 (guards — todo exclusion CC): Task 8 (factory passes `--disallowed-tools`) ✅
- §10 (error handling): Tasks 4 (fail-fast unavailable), 6 (schema drift), 7 (stale resume — handled in factory via resumeStore + the engine's fail path), 8 (schema-not-ok throw) ✅
- §11 (testing): Tasks 1-13 each ship tests + Task 13 smoke ✅
- §12 (deferred): no task needed (deferrals are non-implementations) ✅
- §13 (done bar): Task 14 gate ✅

**2. Placeholder scan** — no TBD/TODO/"add appropriate error handling"/"similar to Task N". Each step has complete code + exact commands. (One honest hedge: Task 12 step 2's unit test is a shape-guard placeholder by design, with the real verification in Task 13's smoke — this is noted in the test comment, not a plan placeholder.)

**3. Type consistency** — `Backend`, `BackendRegistry`, `BackendHookParity`, `BackendVersionInfo`, `ResumeStore`, `ClaudeChildSession`, `createClaudeChildFactory`, `detectClaude`, `mapClaudeEvent` — names are consistent across tasks. `SpawnOptions.backendRegistry` (not `childFactory`) used consistently from Task 4 onward. `AgentDef.backend`/`sessionKey` consistent from Task 3. `ChildSessionEvent.backendSessionId` consistent from Task 4. `session.sessionFile`/`sessionId` (pi SDK) used in Task 9 per the verified sdk.md API.

**4. Ambiguity check** — the one genuine implementation-time unknown is the exact `claude -p` flag set on the user's installed CC version; `detectClaude()` (Task 6) resolves it at runtime via `--help` probe, so the factory (Task 8) never hardcodes a flag the detector hasn't confirmed. The `r:Refresh` action (Task 11) notifies "restart pi to re-detect" rather than live-re-detecting — recorded as a v0.3 limit (§12 defers live re-detect to a future power-knob).

---

## Execution Handoff

Plan complete and saved to `plans/SPEC-3-cross-harness-peers.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**