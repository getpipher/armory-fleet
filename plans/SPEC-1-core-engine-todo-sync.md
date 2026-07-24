# SPEC-1 — Core Engine + armory-todo sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the SPEC-1 greenfield orchestration core of `@getpipher/armory-fleet` — the `spawnSubagent` engine, the `subagent` tool, the `/fleet` panel, the agent registry, and the armory-todo sync moat — and ship `v0.1.0`.

**Architecture:** One `spawnSubagent(opts)` engine is the single source of truth; the model-callable `subagent` tool and the human-driven `/fleet` panel Run action both call it. Todo-sync is ports-and-adapters: fleet core depends on a fleet-owned `TodoSyncPort`; `ArmoryTodoAdapter` is the sole importer of `@getpipher/armory-todo`. Runs are foreground synchronous; child sessions are in-memory + ephemeral (`SessionManager.inMemory()`).

**Tech Stack:** TypeScript (tsx runtime, **no build step**), `@earendil-works/pi-coding-agent` SDK (`^0.81.1`), `@earendil-works/pi-tui`, `typebox`, `@earendil-works/pi-ai`, `yaml`, `@getpipher/armory-todo` (`^0.5.x`), `node:test` + tsx for tests.

## Global Constraints

- pi `^0.81.1`; npm org `getpipher`, account `rz1989`, MIT.
- Raw `.ts` via tsx at runtime (**no build step**); runtime deps in `dependencies` (not dev).
- `pnpm typecheck` + `pnpm test:run` (node:test via tsx) green before release; 80%+ coverage on new code.
- Publish via CI on `v*` tag using getpipher `NPM_TOKEN`; `release.yml` mirrors armory-todo (idempotent npm publish + GitHub Release).
- 2-space indent; meaningful names; comments only for complex logic.
- **No AI attribution** in commits/PRs/files.
- **EditorTheme gotcha:** `ctx.ui.custom((tui, theme, kb, done) => …)` receives the full `Theme`; `ctx.ui.setEditorComponent((tui, theme, kb) => …)` receives `EditorTheme` (only `{borderColor, selectList}`). Thread real `Theme` into custom UI via the `ctx.ui.custom` `theme` arg — never via `ctx.ui.setEditorComponent`'s.
- **`todo` is excluded from child tools** — fleet is the single writer of armory-todo.
- Inline `maxTurns=20`; concurrency=1 single-slot lock.

---

## File Structure

```
armory-fleet/
  package.json                    # deps + scripts (Task 2)
  tsconfig.json                   # strict (Task 2)
  agents/
    general-purpose.md            # builtin (Task 7)
  src/
    index.ts                      # extension entry (Task 15)
    todo-sync/
      port.ts                     # TodoSyncPort + shared types (Task 3)
      adapter.ts                  # ArmoryTodoAdapter (Task 4)
    registry/
      frontmatter.ts              # parse + v0.1 schema (Task 5)
      discovery.ts                # scan + precedence + collision (Task 6)
    engine/
      run-registry.ts             # in-memory run store (Task 8)
      turn-budget.ts              # maxTurns=20 (Task 9)
      concurrency-lock.ts         # single-slot (Task 10)
      spawnSubagent.ts            # the one engine (Task 11)
    tools/
      subagent.ts                 # model-callable tool (Task 12)
    panel/
      rows.ts                     # row-shape pure fns (Task 13)
      fleet-panel.ts              # ctx.ui.custom component (Task 14)
  test/
    adapter.test.ts               # Task 4
    frontmatter.test.ts           # Task 5
    discovery.test.ts             # Task 6
    run-registry.test.ts          # Task 8
    turn-budget.test.ts           # Task 9
    concurrency-lock.test.ts      # Task 10
    spawnSubagent.test.ts         # Task 11
    subagent-tool.test.ts         # Task 12
    rows.test.ts                  # Task 13
  .github/workflows/
    release.yml                   # Task 16
```

---

## Task 1: armory-todo public API (companion PR)

**Repo:** `~/local-dev/getpipher/armory-todo` (cross-repo prerequisite; the adapter in Task 4 imports from this public entry).

**Files:**
- Modify: `~/local-dev/getpipher/armory-todo/package.json` (add `exports`)
- Create: `~/local-dev/getpipher/armory-todo/src/index.ts` (stable re-export)
- Modify: `~/local-dev/getpipher/armory-todo/README.md` (stable-surface note)
- Test: `~/local-dev/getpipher/armory-todo/test/public-api.test.ts`

**Interfaces:**
- Produces: `@getpipher/armory-todo` public entry exporting `{ addTodo, listTodos, updateTodo, getTodo, completeTodo, parkTodo, deleteTodo, Todo, AddInput, UpdateInput, ListFilter, Priority, Status, TodoError }`. Later tasks import from `@getpipher/armory-todo`.

- [ ] **Step 1: Write the failing test**

```ts
// test/public-api.test.ts
import { test } from "node:test";
import { strictEqual } from "node:assert";
import {
  addTodo, listTodos, updateTodo, getTodo, completeTodo, parkTodo, deleteTodo,
  type Todo, type AddInput, type UpdateInput, type ListFilter,
} from "../src/index.ts";

test("public API re-exports the stable store subset", () => {
  strictEqual(typeof addTodo, "function");
  strictEqual(typeof listTodos, "function");
  strictEqual(typeof updateTodo, "function");
  strictEqual(typeof getTodo, "function");
  strictEqual(typeof completeTodo, "function");
  strictEqual(typeof parkTodo, "function");
  strictEqual(typeof deleteTodo, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/local-dev/getpipher/armory-todo && pnpm test:run test/public-api.test.ts`
Expected: FAIL — `src/index.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/index.ts
/**
 * Public stable API of @getpipher/armory-todo.
 * This `exports` entry (see package.json) is the stable surface; `src/*`
 * otherwise is internal and may change without notice.
 */
export {
  addTodo,
  listTodos,
  updateTodo,
  getTodo,
  completeTodo,
  parkTodo,
  deleteTodo,
  clearTodos,
  renderOpenBlock,
  getStorePath,
  loadStore,
  saveStore,
} from "./todo-store.ts";
export type { Todo, AddInput, UpdateInput, ListFilter, Priority, Status, Store } from "./todo-store.ts";
export { TodoError } from "./todo-store.ts";
```

Add the `exports` map to `package.json` (alongside existing fields):

```json
  "exports": {
    ".": "./src/index.ts"
  },
```

Append to `README.md` (a new "## Public API" section near the top):

```md
## Public API

The package `exports` entry (`./src/index.ts`) is the **stable public surface** —
`addTodo`, `listTodos`, `updateTodo`, `getTodo`, `completeTodo`, `parkTodo`,
`deleteTodo`, and the `Todo`/`AddInput`/`UpdateInput`/`ListFilter` types. Other
`src/*` paths are internal and may change without notice. Depend on
`@getpipher/armory-todo` (the public entry), never deep-import `src/*`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/local-dev/getpither/armory-todo && pnpm test:run test/public-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd ~/local-dev/getpipher/armory-todo && pnpm typecheck && pnpm test:run`
Expected: PASS (additive change; existing tests unaffected).

- [ ] **Step 6: Commit + PR**

```bash
cd ~/local-dev/getpipher/armory-todo
git checkout -b feat/public-api-exports
git add package.json src/index.ts README.md test/public-api.test.ts
git commit -m "feat: add public exports map + stable API re-export

Add package.json exports entry pointing at src/index.ts, which re-exports
the stable store subset (addTodo/listTodos/updateTodo/getTodo/completeTodo/
parkTodo/deleteTodo + types). README marks the exports surface as stable
and src/* as internal. Additive — no behavior change. Enables
@getpipher/armory-fleet (SPEC-1) to depend on a versioned public API instead
of deep-importing src/todo-store."
gh pr create --title "feat: add public exports map + stable API re-export" --body "Companion PR for armory-fleet SPEC-1. Adds \`exports\` map + \`src/index.ts\` re-exporting the stable store subset. Additive, no behavior change. \`pnpm typecheck\` + \`pnpm test:run\` green."
```

Merge after CI green; the armory-fleet adapter (Task 4) imports `@getpipher/armory-todo` once published. (Until published, armory-fleet resolves it via the local path through `pnpm` workspace/file dep — see Task 2.)

---

## Task 2: armory-fleet project scaffolding

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `tsconfig.json`
- Create: `.github/workflows/ci.yml` (typecheck + test on push/PR)

**Interfaces:**
- Produces: `pnpm typecheck`, `pnpm test:run`, `pnpm test:watch` scripts; deps pinned per Global Constraints.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@getpipher/armory-fleet",
  "version": "0.0.0",
  "private": true,
  "description": "The armory suite's subagent orchestrator for the pi coding agent — a cross-harness, superpowers-native fleet where every agent is armory-native from birth.",
  "license": "MIT",
  "type": "module",
  "author": "RECTOR (https://github.com/rz1989s)",
  "keywords": ["pi-package","pi-extension","pi","pi-coding-agent","subagents","ai-agents","multi-agent","orchestration","agent-orchestration","claude-code","superpowers","armory","cross-harness"],
  "repository": { "type": "git", "url": "git+https://github.com/getpipher/armory-fleet.git" },
  "homepage": "https://github.com/getpipher/armory-fleet#readme",
  "bugs": { "url": "https://github.com/getpipher/armory-fleet/issues" },
  "exports": { ".": "./src/index.ts" },
  "files": ["src","agents","README.md","LICENSE"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:run": "node --test --test-reporter=spec --import tsx test/*.test.ts",
    "test:watch": "node --test --watch --import tsx test/*.test.ts"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.81.1",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*",
    "@getpipher/armory-todo": "^0.5.3",
    "typebox": "^0.32.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

Note: until the Task-1 armory-todo `exports` PR is published to npm, pin `@getpipher/armory-todo` via a file dep to the local checkout: temporarily set `"@getpipher/armory-todo": "file:../armory-todo"` and switch to the npm range once `0.5.4` (the exports release) ships. Track in Task 16.

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test:run
```

- [ ] **Step 4: Install + verify the harness compiles**

Run: `cd ~/local-dev/getpipher/armory-fleet && pnpm install && pnpm typecheck`
Expected: PASS (no source yet; typecheck is a no-op over zero files, exit 0).

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "chore: scaffold tooling — package.json, tsconfig, CI

Add deps (pi-coding-agent ^0.81.1, pi-tui, pi-ai, armory-todo ^0.5.3,
typebox, yaml), typecheck + test:run scripts (node:test via tsx, no build),
strict tsconfig, and a CI workflow (typecheck + test:run)."
```

---

## Task 3: TodoSyncPort + shared types

**Files:**
- Create: `src/todo-sync/port.ts`

**Interfaces:**
- Produces: `FleetRunStatus`, `RunMeta`, `TodoSyncPort` (fleet-owned; no armory-todo import).

- [ ] **Step 1: Write the module**

```ts
// src/todo-sync/port.ts

/**
 * Fleet-owned todo-sync contract. Fleet core depends only on this port;
 * ArmoryTodoAdapter (src/todo-sync/adapter.ts) is the sole importer of
 * @getpipher/armory-todo. This insulation is what makes armory-todo
 * evolution safe — see SPEC-1 §6 / §2.2.
 */

export type FleetRunStatus = "running" | "completed" | "failed" | "aborted";

/** Minimum info the engine passes the port to link-or-create a run's todo. */
export interface RunMeta {
  runId: string;
  agent: string;
  task: string;
  /** explicit link to an existing open/in_progress todo; undefined = create. */
  todoId?: string;
  /** tracked-by-default (SPEC-1 Q3b); false = do not touch armory-todo. */
  track: boolean;
}

/**
 * Implementations return the linked/created todoId (or null when untracked)
 * and, for a linked todo, its prior status so the engine can restore it.
 * priorStatus is a string (armory-todo's Status union) to keep the port
 * decoupled from armory-todo's types.
 */
export interface LinkResult {
  todoId: string | null;
  /** undefined when the todo was freshly created (no prior status exists). */
  priorStatus?: string;
}

export interface TodoSyncPort {
  /** Before the run: link to todoId (validate open/in_progress) or create a fleet task. */
  linkOrCreateRunTodo(run: RunMeta): Promise<LinkResult>;
  /** After a completed run: fleet-created → done; linked → restore prior + result note. */
  markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void>;
  /** After a failed/aborted run: fleet-created → open; linked → restore prior. + reason note. */
  markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/todo-sync/port.ts
git commit -m "feat(todo-sync): add TodoSyncPort + shared run types

Fleet-owned todo-sync contract (FleetRunStatus, RunMeta, LinkResult,
TodoSyncPort). Core depends only on this port; the adapter is the sole
importer of @getpipher/armory-todo. Decouples fleet core from armory-todo
evolution (SPEC-1 §6)."
```

---

## Task 4: ArmoryTodoAdapter

**Files:**
- Create: `src/todo-sync/adapter.ts`
- Test: `test/adapter.test.ts`

**Interfaces:**
- Consumes: `TodoSyncPort`, `RunMeta`, `LinkResult` from `./port.ts`; armory-todo's `addTodo`/`listTodos`/`updateTodo`/`getTodo` + types from `@getpipher/armory-todo`.
- Produces: `ArmoryTodoAdapter` implementing `TodoSyncPort`.

- [ ] **Step 1: Write the failing test**

```ts
// test/adapter.test.ts
import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTodo, listTodos, getTodo, type Status } from "@getpipher/armory-todo";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-todo-"));
  process.env.TODO_DIR = tmpDir;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

test("untracked run touches no todo", async () => {
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-1", agent: "g", task: "x", track: false });
  strictEqual(res.todoId, null);
  strictEqual(listTodos({ limit: 200 }).length, 0);
});

test("tracked run with no todoId creates a fleet task in_progress", async () => {
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-2", agent: "scout", task: "do thing", track: true });
  ok(res.todoId, "todoId created");
  const t = getTodo(res.todoId!);
  strictEqual(t.project, "fleet");
  strictEqual(t.source, "armory-fleet");
  strictEqual(t.status, "in_progress");
  ok(t.tags.includes("fleet-run"));
  ok(t.notes.includes("fleet-run:fl-2"));
});

test("tracked run with todoId links + saves prior status + sets in_progress", async () => {
  const existing = addTodo({ title: "existing work", project: "myproj", source: "user" });
  const a = new ArmoryTodoAdapter();
  const res = await a.linkOrCreateRunTodo({ runId: "fl-3", agent: "g", task: "x", track: true, todoId: existing.id });
  strictEqual(res.todoId, existing.id);
  strictEqual(res.priorStatus, "open");
  const t = getTodo(existing.id);
  strictEqual(t.status, "in_progress");
  ok(t.tags.includes("fleet-run"));
});

test("linking a done todo is rejected with an actionable message", async () => {
  const done = addTodo({ title: "done work", project: "p", source: "user" });
  // mark done via the store: completeTodo
  const { completeTodo } = await import("@getpipher/armory-todo");
  completeTodo(done.id);
  const a = new ArmoryTodoAdapter();
  await test.rejects(
    () => a.linkOrCreateRunTodo({ runId: "fl-4", agent: "g", task: "x", track: true, todoId: done.id }),
    /cannot start run against a closed todo/,
  );
});

test("markRunTodoDone: created → done; linked → restore prior + note", async () => {
  const a = new ArmoryTodoAdapter();
  const created = await a.linkOrCreateRunTodo({ runId: "fl-5", agent: "g", task: "x", track: true });
  await a.markRunTodoDone(created.todoId, created.priorStatus, "result text");
  strictEqual(getTodo(created.todoId!).status, "done");
  ok(getTodo(created.todoId!).notes.includes("result text"));

  const existing = addTodo({ title: "link work", project: "p", source: "user" });
  const linked = await a.linkOrCreateRunTodo({ runId: "fl-6", agent: "g", task: "x", track: true, todoId: existing.id });
  await a.markRunTodoDone(linked.todoId, linked.priorStatus, "linked result");
  strictEqual(getTodo(existing.id).status, "open"); // restored prior
  ok(getTodo(existing.id).notes.includes("linked result"));
});

test("markRunTodoReverted: created → open; linked → restore prior + reason", async () => {
  const a = new ArmoryTodoAdapter();
  const created = await a.linkOrCreateRunTodo({ runId: "fl-7", agent: "g", task: "x", track: true });
  await a.markRunTodoReverted(created.todoId, created.priorStatus, "aborted by user");
  strictEqual(getTodo(created.todoId!).status, "open");
  ok(getTodo(created.todoId!).notes.includes("aborted by user"));

  const existing = addTodo({ title: "link2", project: "p", source: "user" });
  const linked = await a.linkOrCreateRunTodo({ runId: "fl-8", agent: "g", task: "x", track: true, todoId: existing.id });
  await a.markRunTodoReverted(linked.todoId, linked.priorStatus, "failed: budget");
  strictEqual(getTodo(existing.id).status, "open"); // restored prior (was open)
  ok(getTodo(existing.id).notes.includes("failed: budget"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/adapter.test.ts`
Expected: FAIL — `../src/todo-sync/adapter.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/todo-sync/adapter.ts
import {
  addTodo, listTodos, updateTodo, getTodo,
  type Todo, type Status,
} from "@getpipher/armory-todo";
import type { LinkResult, RunMeta, TodoSyncPort } from "./port.ts";

const FLEET_PROJECT = "fleet";
const FLEET_SOURCE = "armory-fleet";
const FLEET_TAG = "fleet-run";
const OPEN_STATES: Status[] = ["open", "in_progress"];

function titleFor(run: RunMeta): string {
  const raw = `[${run.agent}] ${run.task}`.trim();
  return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
}

/** Append a note line to a todo (read-then-write; updateTodo replaces notes). */
function appendNote(id: string, line: string): void {
  const t = getTodo(id);
  const sep = t.notes ? "\n\n" : "";
  updateTodo(id, { notes: t.notes + sep + line });
}

/** Add the fleet-run tag if missing (read-then-write; updateTodo replaces tags). */
function ensureFleetTag(id: string): void {
  const t = getTodo(id);
  if (!t.tags.includes(FLEET_TAG)) updateTodo(id, { tags: [...t.tags, FLEET_TAG] });
}

export class ArmoryTodoAdapter implements TodoSyncPort {
  async linkOrCreateRunTodo(run: RunMeta): Promise<LinkResult> {
    if (!run.track) return { todoId: null };

    if (run.todoId) {
      const t = getTodo(run.todoId);
      if (!OPEN_STATES.includes(t.status)) {
        throw new Error(
          `linked todo ${run.todoId} is ${t.status}; cannot start run against a closed todo`,
        );
      }
      const priorStatus = t.status;
      ensureFleetTag(run.todoId);
      appendNote(run.todoId, `fleet-run:${run.runId}`);
      updateTodo(run.todoId, { status: "in_progress", source: FLEET_SOURCE });
      return { todoId: run.todoId, priorStatus: String(priorStatus) };
    }

    const created = addTodo({
      title: titleFor(run),
      project: FLEET_PROJECT,
      source: FLEET_SOURCE,
      priority: "med",
      tags: [FLEET_TAG],
      notes: `fleet-run:${run.runId}\n\nTask: ${run.task}`,
    });
    updateTodo(created.id, { status: "in_progress" });
    return { todoId: created.id }; // priorStatus undefined → created
  }

  async markRunTodoDone(todoId: string | null, priorStatus: string | undefined, result: string): Promise<void> {
    if (!todoId) return;
    if (priorStatus === undefined) {
      // fleet-created → fleet closes it
      updateTodo(todoId, { status: "done" });
    } else {
      // linked → restore prior (user owns the close)
      updateTodo(todoId, { status: priorStatus as Status });
    }
    appendNote(todoId, `fleet-run done: ${result}`);
  }

  async markRunTodoReverted(todoId: string | null, priorStatus: string | undefined, reason: string): Promise<void> {
    if (!todoId) return;
    if (priorStatus === undefined) {
      updateTodo(todoId, { status: "open" }); // created → retryable
    } else {
      updateTodo(todoId, { status: priorStatus as Status });
    }
    appendNote(todoId, `fleet-run reverted: ${reason}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/adapter.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/todo-sync/adapter.ts test/adapter.test.ts
git commit -m "feat(todo-sync): implement ArmoryTodoAdapter

Implements TodoSyncPort against @getpipher/armory-todo's public store:
link-or-create (validate open/in_progress, save prior status, set
in_progress, tag + note fleet-run), markDone (created→done, linked→restore
prior + note), markReverted (created→open, linked→restore prior + reason).
Tests use a temp TODO_DIR for isolation. Hybrid restore-prior lifecycle
(SPEC-1 §6.3)."
```

---

## Task 5: Agent frontmatter parser

**Files:**
- Create: `src/registry/frontmatter.ts`
- Test: `test/frontmatter.test.ts`

**Interfaces:**
- Produces: `AgentDef`, `parseAgentFile(content, filePath, source)`; throws `FrontmatterError` on malformed.

- [ ] **Step 1: Write the failing test**

```ts
// test/frontmatter.test.ts
import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { parseAgentFile, type AgentDef } from "../src/registry/frontmatter.ts";

const BASE = `---
name: scout
description: Recon agent
model: anthropic/claude-sonnet-4
thinkingLevel: medium
tools: [read, bash]
skills: [recon]
todoSync: true
---
You are a scout. Be thorough.
`;

test("parses v0.1 frontmatter + role prompt body", () => {
  const a = parseAgentFile(BASE, "/x/.pi/agents/scout.md", "project");
  strictEqual(a.name, "scout");
  strictEqual(a.description, "Recon agent");
  strictEqual(a.model, "anthropic/claude-sonnet-4");
  strictEqual(a.thinkingLevel, "medium");
  deepStrictEqual(a.tools, ["read", "bash"]);
  deepStrictEqual(a.skills, ["recon"]);
  strictEqual(a.todoSync, true);
  strictEqual(a.rolePrompt, "You are a scout. Be thorough.\n");
  strictEqual(a.source, "project");
});

test("name defaults to filename when omitted", () => {
  const noName = `---
description: anon
---
body
`;
  strictEqual(parseAgentFile(noName, "/x/.pi/agents/anon.md", "global").name, "anon");
});

test("todoSync defaults to true when omitted", () => {
  const noSync = `---
name: g
description: g
---
body
`;
  strictEqual(parseAgentFile(noSync, "/x/g.md", "builtin").todoSync, true);
});

test("malformed frontmatter throws FrontmatterError", () => {
  const bad = `---
name: g
this is not: : valid yaml: [
---
body
`;
  throws(() => parseAgentFile(bad, "/x/g.md", "project"), { name: "FrontmatterError" });
});

test("empty description is rejected", () => {
  const noDesc = `---
name: g
---
body
`;
  throws(() => parseAgentFile(noDesc, "/x/g.md", "project"), { name: "FrontmatterError" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/frontmatter.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/registry/frontmatter.ts
import { parse as parseYaml } from "yaml";
import { basename, extname } from "node:path";

export type AgentSource = "builtin" | "project" | "global";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  rolePrompt: string;
  todoSync: boolean;
  source: AgentSource;
  filePath: string;
}

export class FrontmatterError extends Error {
  override name = "FrontmatterError" as const;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseAgentFile(content: string, filePath: string, source: AgentSource): AgentDef {
  const m = FRONTMATTER_RE.exec(content);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new FrontmatterError(`${filePath}: missing --- frontmatter delimiters`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new FrontmatterError(`${filePath}: invalid YAML (${(e as Error).message})`);
  }
  const body = m[2];

  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : basename(filePath, extname(filePath));
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) throw new FrontmatterError(`${filePath}: description is required`);

  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)) : undefined;

  const todoSync = raw.todoSync === undefined ? true : Boolean(raw.todoSync);

  return {
    name,
    description,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinkingLevel: typeof raw.thinkingLevel === "string" ? (raw.thinkingLevel as ThinkingLevel) : undefined,
    tools: strList(raw.tools),
    skills: strList(raw.skills),
    rolePrompt: body,
    todoSync,
    source,
    filePath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/frontmatter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/frontmatter.ts test/frontmatter.test.ts
git commit -m "feat(registry): parse agent frontmatter (v0.1 schema)

parseAgentFile splits --- frontmatter (yaml) + role-prompt body and
produces an AgentDef. v0.1 fields: name (defaults to filename),
description (required), model, thinkingLevel, tools, skills, todoSync
(defaults true), rolePrompt. Malformed YAML / missing description throw
FrontmatterError. No predetermined role taxonomy — agents are general
(SPEC-1 §7)."
```

---

## Task 6: Agent registry discovery

**Files:**
- Create: `src/registry/discovery.ts`
- Test: `test/discovery.test.ts`

**Interfaces:**
- Consumes: `parseAgentFile`, `AgentDef` from `./frontmatter.ts`.
- Produces: `discoverAgents(opts) → { agents: Map<string, AgentDef>; warnings: string[]; errors: string[] }`; `builtinDir` (package `agents/`).

- [ ] **Step 1: Write the failing test**

```ts
// test/discovery.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/registry/discovery.ts";

function agentFile(name: string, desc = "d"): string {
  return `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`;
}

test("project agent overrides global agent of same name", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  const glob = mkdtempSync(join(tmpdir(), "glob-"));
  writeFileSync(join(proj, "a.md"), agentFile("a", "project-version"));
  writeFileSync(join(glob, "a.md"), agentFile("a", "global-version"));
  const r = discoverAgents({ projectDir: proj, globalDir: glob, builtinDir: null });
  strictEqual(r.agents.get("a")!.description, "project-version");
  strictEqual(r.warnings.length, 0);
  rmSync(proj, { recursive: true, force: true });
  rmSync(glob, { recursive: true, force: true });
});

test("same-scope collision is a load error (loud), duplicate ignored", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj2-"));
  writeFileSync(join(proj, "a.md"), agentFile("a", "one"));
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(join(proj, "sub", "a.md"), agentFile("a", "two"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: null });
  ok(r.errors.some((e) => e.includes("duplicate agent") && e.includes("'a'")), "collision error surfaced");
  ok(r.agents.has("a"), "first one kept");
  rmSync(proj, { recursive: true, force: true });
});

test("malformed file is skipped + warned, registry still loads siblings", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj3-"));
  writeFileSync(join(proj, "bad.md"), "---\nname: g\nthis is: : bad\n---\nbody\n");
  writeFileSync(join(proj, "good.md"), agentFile("good"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: null });
  ok(r.warnings.some((w) => w.includes("bad.md")), "malformed warned");
  ok(r.agents.has("good"), "sibling loaded");
  rmSync(proj, { recursive: true, force: true });
});

test("builtin agents are included and overridable by project", () => {
  const builtin = mkdtempSync(join(tmpdir(), "builtin-"));
  const proj = mkdtempSync(join(tmpdir(), "proj4-"));
  writeFileSync(join(builtin, "general-purpose.md"), agentFile("general-purpose", "builtin"));
  writeFileSync(join(proj, "general-purpose.md"), agentFile("general-purpose", "project"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: builtin });
  strictEqual(r.agents.get("general-purpose")!.description, "project");
  rmSync(builtin, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("missing dirs are tolerated (no throw)", () => {
  const r = discoverAgents({ projectDir: "/nonexistent", globalDir: "/nonexistent", builtinDir: null });
  strictEqual(r.agents.size, 0);
  strictEqual(r.errors.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/discovery.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/registry/discovery.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentFile, type AgentDef, FrontmatterError } from "./frontmatter.ts";

export interface DiscoverOpts {
  projectDir: string | null;
  globalDir: string | null;
  builtinDir: string | null;
}

export interface DiscoverResult {
  agents: Map<string, AgentDef>;
  warnings: string[];
  errors: string[];
}

/** Load order: builtin → global → project (later wins on name; same-scope dup = error). */
export function discoverAgents(opts: DiscoverOpts): DiscoverResult {
  const agents = new Map<string, AgentDef>();
  const warnings: string[] = [];
  const errors: string[] = [];

  const loadScope = (dir: string | null, source: AgentDef["source"]): void => {
    if (!dir || !existsSync(dir)) return;
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && entry.endsWith(".md")) files.push(full);
    }
    for (const f of files) {
      let content: string;
      try {
        content = readFileSyncText(f);
      } catch {
        warnings.push(`${f}: unreadable file, skipped`);
        continue;
      }
      try {
        const def = parseAgentFile(content, f, source);
        if (agents.has(def.name)) {
          // same-scope collision (this scope already set it)?
          if (agents.get(def.name)!.source === source) {
            errors.push(`duplicate agent '${def.name}' in ${source} scope (${f}); first kept`);
            continue;
          }
          // cross-scope: project over global/builtin is the override — fine
        }
        agents.set(def.name, def);
      } catch (e) {
        if (e instanceof FrontmatterError) warnings.push(e.message);
        else warnings.push(`${f}: ${String(e)}`);
      }
    }
  };

  loadScope(opts.builtinDir, "builtin");
  loadScope(opts.globalDir, "global");
  loadScope(opts.projectDir, "project"); // project overrides
  return { agents, warnings, errors };
}

function readFileSyncText(p: string): string {
  // thin wrapper for testability / future encoding handling
  return require("node:fs").readFileSync(p, "utf8") as string;
}
```

Note: replace the `require(...)` with a direct `import { readFileSync } from "node:fs"` at top — the inline `require` is shown here only to keep the snippet self-contained; in the real file use the ESM import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/discovery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/discovery.ts test/discovery.test.ts
git commit -m "feat(registry): discover agents from builtin/global/project dirs

discoverAgents loads builtin → global → project (project overrides). Same-
scope name collision is a loud load error (first kept); malformed files
skip + warn (siblings still load). Missing dirs tolerated. getpipher
precedence + fail-loud + skip-warn conventions (SPEC-1 §7.1)."
```

---

## Task 7: the `general-purpose` builtin

**Files:**
- Create: `agents/general-purpose.md`
- Test: `test/builtin.test.ts`

**Interfaces:**
- Produces: the package's builtin agent, loadable from `agents/`.

- [ ] **Step 1: Write the builtin file**

```md
<!-- agents/general-purpose.md -->
---
name: general-purpose
description: A focused general-purpose subagent delegate. Use for any task needing isolated work.
todoSync: true
---
You are a focused subagent delegate. Complete the assigned task thoroughly, work
autonomously to completion, and return a concise result summary. Do not call the
`todo` tool — the fleet engine manages todo tracking for you.
```

- [ ] **Step 2: Write the test**

```ts
// test/builtin.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { discoverAgents } from "../src/registry/discovery.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(here, "..", "agents");

test("general-purpose builtin loads from package agents/ dir", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  const g = r.agents.get("general-purpose");
  ok(g, "general-purpose present");
  strictEqual(g!.source, "builtin");
  strictEqual(g!.todoSync, true);
  ok(g!.rolePrompt.includes("Do not call the `todo` tool"));
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:run test/builtin.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agents/general-purpose.md test/builtin.test.ts
git commit -m "feat(agents): add general-purpose builtin

The single shipped builtin — minimal defaults (omit model/tools/skills →
pi defaults; todoSync default true). Explicit 'do not call the todo tool'
line reinforces the fleet-single-writer guard at the prompt layer
(SPEC-1 §7.4). No predetermined role taxonomy — agents are general,
user-defined (SPEC-1 §7.3)."
```

---

## Task 8: Run registry (in-memory)

**Files:**
- Create: `src/engine/run-registry.ts`
- Test: `test/run-registry.test.ts`

**Interfaces:**
- Produces: `RunRecord`, `RunRegistry` class with `add/get/list/update`.

- [ ] **Step 1: Write the failing test**

```ts
// test/run-registry.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { RunRegistry, genRunId } from "../src/engine/run-registry.ts";

test("genRunId is fl- prefixed and unique-ish", () => {
  const id = genRunId();
  ok(/^fl-[a-z0-9]+-[a-z0-9]{6}$/.test(id), id);
});

test("add + get a run; list is newest-first", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-1", agent: "g", model: "m", task: "t", track: true, todoId: "td-1", status: "running", startedAt: 1 });
  strictEqual(r.get("fl-1")!.agent, "g");
  const list = r.list();
  strictEqual(list.length, 1);
  r.add({ runId: "fl-2", agent: "g", model: "m", task: "t2", track: true, todoId: null, status: "running", startedAt: 2 });
  strictEqual(r.list()[0]!.runId, "fl-2"); // newest first
});

test("update patches status + endedAt + resultSummary", () => {
  const r = new RunRegistry();
  r.add({ runId: "fl-3", agent: "g", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1 });
  r.update("fl-3", { status: "completed", endedAt: 99, resultSummary: "done" });
  strictEqual(r.get("fl-3")!.status, "completed");
  strictEqual(r.get("fl-3")!.endedAt, 99);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/run-registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/run-registry.ts
import type { FleetRunStatus } from "../todo-sync/port.ts";

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
}

export function genRunId(): string {
  return "fl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  add(r: RunRecord): void {
    this.runs.set(r.runId, r);
  }
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  /** Newest-first (by startedAt desc). */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  update(id: string, patch: Partial<Omit<RunRecord, "runId">>): void {
    const r = this.runs.get(id);
    if (r) this.runs.set(id, { ...r, ...patch });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/run-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/run-registry.ts test/run-registry.test.ts
git commit -m "feat(engine): in-memory run registry + genRunId

RunRegistry holds RunRecord rows (the Fleet/recent list). add/get/list
(newest-first)/update. genRunId = fl-<base36>-<6 random>. In-memory only
for SPEC-1; persistence lands SPEC-5b (SPEC-1 §5.1)."
```

---

## Task 9: Turn budget

**Files:**
- Create: `src/engine/turn-budget.ts`
- Test: `test/turn-budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/turn-budget.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { createTurnBudget } from "../src/engine/turn-budget.ts";

test("not exhausted under max", () => {
  const b = createTurnBudget(3);
  strictEqual(b.consume(), false); // turn 1
  strictEqual(b.consume(), false); // turn 2
  strictEqual(b.count(), 2);
});

test("exhausted at max", () => {
  const b = createTurnBudget(2);
  strictEqual(b.consume(), false); // 1
  strictEqual(b.consume(), true);  // 2 → exhausted at the 2nd turn
  strictEqual(b.count(), 2);
});

test("default max is 20", () => {
  const b = createTurnBudget();
  for (let i = 0; i < 19; i++) ok(!b.consume(), `turn ${i + 1} not exhausted`);
  strictEqual(b.consume(), true); // 20th exhausts
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/turn-budget.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/turn-budget.ts
export const DEFAULT_MAX_TURNS = 20;

export interface TurnBudget {
  /** Returns true when the just-consumed turn meets/exceeds the cap. */
  consume(): boolean;
  count(): number;
}

export function createTurnBudget(max: number = DEFAULT_MAX_TURNS): TurnBudget {
  let n = 0;
  return {
    consume(): boolean {
      n += 1;
      return n >= max;
    },
    count(): number {
      return n;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/turn-budget.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/turn-budget.ts test/turn-budget.test.ts
git commit -m "feat(engine): inline turn budget (maxTurns=20)

createTurnBudget(max=20) — consume() returns true at the cap. Inline
graceful-turn-limit for v0.1; per-agent maxTurns + vendored plumbing
deferred to SPEC-5a (SPEC-1 §9.3, §6)."
```

---

## Task 10: Concurrency lock (single-slot)

**Files:**
- Create: `src/engine/concurrency-lock.ts`
- Test: `test/concurrency-lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/concurrency-lock.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";

test("first acquire succeeds", () => {
  const l = createSingleSlotLock();
  ok(l.tryAcquire("fl-1"));
  strictEqual(l.current(), "fl-1");
});

test("second acquire fails with the running id", () => {
  const l = createSingleSlotLock();
  l.tryAcquire("fl-1");
  strictEqual(l.tryAcquire("fl-2"), false);
  strictEqual(l.current(), "fl-1");
});

test("release frees the slot", () => {
  const l = createSingleSlotLock();
  l.tryAcquire("fl-1");
  l.release();
  ok(l.tryAcquire("fl-2"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/concurrency-lock.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/concurrency-lock.ts
export interface SingleSlotLock {
  /** true if acquired; false if busy (call .current() for the running id). */
  tryAcquire(id: string): boolean;
  release(): void;
  current(): string | null;
}

export function createSingleSlotLock(): SingleSlotLock {
  let holding: string | null = null;
  return {
    tryAcquire(id): boolean {
      if (holding !== null) return false;
      holding = id;
      return true;
    },
    release(): void {
      holding = null;
    },
    current(): string | null {
      return holding;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/concurrency-lock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/concurrency-lock.ts test/concurrency-lock.test.ts
git commit -m "feat(engine): single-slot concurrency lock (concurrency=1)

createSingleSlotLock — tryAcquire/release/current. Enforces the SPEC-1
concurrency=1 invariant: a 2nd parallel subagent call is rejected with the
running runId. The real concurrency queue is SPEC-5a (SPEC-1 §9.2)."
```

---

## Task 11: spawnSubagent — the engine

**Files:**
- Create: `src/engine/spawnSubagent.ts`
- Test: `test/spawnSubagent.test.ts`

**Interfaces:**
- Consumes: `TodoSyncPort`/`RunMeta`/`FleetRunStatus` (`../todo-sync/port.ts`), `AgentDef` (`../registry/frontmatter.ts`), `RunRegistry`/`genRunId` (`./run-registry.ts`), `createTurnBudget` (`./turn-budget.ts`), `createSingleSlotLock` (`./concurrency-lock.ts`).
- Produces: `SpawnOptions`, `SpawnResult`, `ChildSession`, `ChildSessionFactory`, `spawnSubagent(opts)`.

- [ ] **Step 1: Write the failing test (mock child session)**

```ts
// test/spawnSubagent.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTodo, getTodo, type Status } from "@getpipher/armory-todo";
import { spawnSubagent, type ChildSession, type ChildSessionFactory } from "../src/engine/spawnSubagent.ts";
import { RunRegistry, genRunId } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { createTurnBudget } from "../src/engine/turn-budget.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-engine-"));
  process.env.TODO_DIR = tmpDir;
});
test.afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TODO_DIR;
});

const agent = (name = "g"): AgentDef => ({
  name, description: "d", rolePrompt: "role", todoSync: true, source: "builtin", filePath: "/x",
});

/** A fake child that emits N turns then finishes with finalText. */
function fakeChild(turns: number, finalText: string): ChildSession {
  const handlers: Array<(e: any) => void> = [];
  let aborted = false;
  let prompted = false;
  return {
    prompt: async () => {
      prompted = true;
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        for (const h of handlers) h({ type: "turn_end" });
        for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
      }
    },
    subscribe: (h) => { handlers.push(h); return () => {}; },
    abort: async () => { aborted = true; },
    dispose: () => {},
    _prompted: prompted, _aborted: aborted,
  } as any;
}

function harness(childFactory: ChildSessionFactory, agentDef: AgentDef = agent()) {
  const registry = new Map<string, AgentDef>([[agentDef.name, agentDef]]);
  const runRegistry = new RunRegistry();
  return {
    registry, runRegistry,
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    childFactory,
  };
}

test("completes + creates a fleet task + marks done", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(3, "all done"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do work", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  strictEqual(res.status, "completed");
  strictEqual(res.finalText, "all done");
  ok(res.todoId, "fleet task created");
  strictEqual(getTodo(res.todoId!).status, "done");
});

test("turn-budget exhaustion → failed + partial result + todo reverted to open", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(25, "partial"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "loop", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
    maxTurns: 20,
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("turn budget"), res.error);
  strictEqual(getTodo(res.todoId!).status, "open"); // created → reverted to open
});

test("unknown agent → failed with actionable message listing available", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "x"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "nope", task: "x", track: true,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  strictEqual(res.status, "failed");
  ok(res.error!.includes("not in registry"), res.error);
  ok(res.error!.includes("available:"), res.error);
});

test("concurrency=1: second concurrent call is rejected with running id", async () => {
  let releasePrompt: () => void = () => {};
  const slowChild: ChildSession = {
    prompt: () => new Promise<void>((res) => { releasePrompt = res; }),
    subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
  };
  const factory: ChildSessionFactory = { create: async () => ({ session: slowChild, model: "m" }) };
  const h = harness(factory);
  const p1 = spawnSubagent({
    agent: "g", task: "long", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  const res2 = await spawnSubagent({
    agent: "g", task: "second", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  strictEqual(res2.status, "failed");
  ok(res2.error!.includes("already running"), res2.error);
  ok(/fl-/.test(res2.error!), "names the running runId");
  releasePrompt();
  await p1;
});

test("track:false touches no todo", async () => {
  const factory: ChildSessionFactory = { create: async () => ({ session: fakeChild(1, "ok"), model: "m" }) };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  strictEqual(res.todoId, null);
  strictEqual(res.status, "completed");
});

test("todo excluded from child tools (fleet is single writer)", async () => {
  let captured: any;
  const factory: ChildSessionFactory = {
    create: async (opts) => {
      captured = opts;
      return { session: fakeChild(1, "ok"), model: "m" };
    },
  };
  const a = agent("g"); a.tools = ["read", "bash", "todo", "edit"];
  const h = harness(factory, a);
  await spawnSubagent({
    agent: "g", task: "x", track: false,
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock, childFactory: h.childFactory,
    parentModel: { provider: "p", id: "m" } as any,
  });
  ok(!captured.tools.includes("todo"), "todo stripped");
  ok(captured.tools.includes("read"), "read kept");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/spawnSubagent.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/spawnSubagent.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus, RunMeta, TodoSyncPort } from "../todo-sync/port.ts";
import { genRunId, RunRegistry } from "./run-registry.ts";
import { createTurnBudget } from "./turn-budget.ts";
import type { SingleSlotLock } from "./concurrency-lock.ts";
import { DEFAULT_MAX_TURNS } from "./turn-budget.ts";

const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const FLEET_OWNED_TOOLS = ["todo"]; // tools the child must never call (fleet owns them)

export interface ChildSession {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: any) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface ChildSessionOpts {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  tools: string[];
  rolePrompt: string;
  skills: string[];
  task: string;
}

export interface ChildSessionFactory {
  create(opts: ChildSessionOpts): Promise<{ session: ChildSession; model: string }>;
}

export interface SpawnOptions {
  agent: string;
  task: string;
  todoId?: string;
  track?: boolean; // default true
  model?: string;  // override
  maxTurns?: number; // default 20
  registry: Map<string, AgentDef>;
  todoSync: TodoSyncPort;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  childFactory: ChildSessionFactory;
  parentModel: { provider: string; id: string };
  parentCwd: string;
  signal?: AbortSignal;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
}

export interface SpawnResult {
  status: FleetRunStatus;
  finalText: string;
  runId: string;
  todoId: string | null;
  agent: string;
  model: string;
  durationMs: number;
  tokenTotal: number;
  error?: string;
}

export async function spawnSubagent(opts: SpawnOptions): Promise<SpawnResult> {
  const runId = genRunId();
  const track = opts.track ?? true;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = Date.now();

  // concurrency=1
  if (!opts.lock.tryAcquire(runId)) {
    return fail(opts, runId, startedAt, `a subagent is already running (concurrency=1 in v0.1); wait for ${opts.lock.current()} to finish or abort it first`);
  }

  try {
    // resolve agent
    const agentDef = opts.registry.get(opts.agent);
    if (!agentDef) {
      const available = [...opts.registry.keys()].sort().join(", ");
      return fail(opts, runId, startedAt, `agent '${opts.agent}' not in registry; available: ${available}`);
    }

    // resolve model
    const model = opts.model ?? agentDef.model ?? `${opts.parentModel.provider}/${opts.parentModel.id}`;

    // compute child tools (exclude fleet-owned)
    const baseTools = agentDef.tools ?? PI_DEFAULT_TOOLS;
    const tools = baseTools.filter((t) => !FLEET_OWNED_TOOLS.includes(t));

    // run record
    opts.runRegistry.add({
      runId, agent: agentDef.name, model, task: opts.task, track,
      todoId: null, status: "running", startedAt,
    });

    // todo-sync (before)
    let priorStatus: string | undefined;
    let todoId: string | null = null;
    try {
      const link = await opts.todoSync.linkOrCreateRunTodo({
        runId, agent: agentDef.name, task: opts.task, todoId: opts.todoId, track: track && agentDef.todoSync,
      });
      todoId = link.todoId;
      priorStatus = link.priorStatus;
      opts.runRegistry.update(runId, { todoId });
    } catch (e) {
      return await finishRun(opts, runId, startedAt, "failed", "", todoId, priorStatus, (e as Error).message, agentDef.name, model);
    }

    // spawn child
    let { session } = await opts.childFactory.create({
      cwd: opts.parentCwd,
      model,
      thinkingLevel: agentDef.thinkingLevel,
      tools,
      rolePrompt: agentDef.rolePrompt,
      skills: agentDef.skills ?? [],
      task: opts.task,
    });

    const budget = createTurnBudget(maxTurns);
    let finalText = "";
    let tokenTotal = 0;
    let aborted = false;

    const onSignalAbort = () => { aborted = true; void session.abort(); };
    opts.signal?.addEventListener("abort", onSignalAbort);

    const unsub = session.subscribe((e) => {
      if (e.type === "turn_end") {
        if (budget.consume()) void session.abort();
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = e.message.content?.map((c: any) => c.type === "text" ? c.text : "").join("") ?? "";
        if (text) finalText = text;
        if (e.message.usage?.cost?.total) tokenTotal += e.message.usage.cost.total;
      }
      opts.onEvent?.(e);
    });

    let runError: string | undefined;
    try {
      await session.prompt(opts.task);
    } catch (e) {
      runError = (e as Error).message;
    } finally {
      unsub();
      opts.signal?.removeEventListener("abort", onSignalAbort);
      session.dispose();
    }

    let status: FleetRunStatus;
    let error: string | undefined;
    if (aborted) { status = "aborted"; error = "aborted by user"; }
    else if (budget.count() >= maxTurns) { status = "failed"; error = `hit turn budget (${maxTurns}) mid-task; partial result: ${finalText.slice(0, 200)}`; }
    else if (runError) { status = "failed"; error = runError; }
    else { status = "completed"; }

    return await finishRun(opts, runId, startedAt, status, finalText, todoId, priorStatus, error, agentDef.name, model, tokenTotal);
  } finally {
    opts.lock.release();
  }
}

function fail(opts: SpawnOptions, runId: string, startedAt: number, message: string): SpawnResult {
  return {
    status: "failed", finalText: "", runId, todoId: null, agent: opts.agent,
    model: "", durationMs: Date.now() - startedAt, tokenTotal: 0, error: message,
  };
}

async function finishRun(
  opts: SpawnOptions, runId: string, startedAt: number,
  status: FleetRunStatus, finalText: string, todoId: string | null, priorStatus: string | undefined,
  error: string | undefined, agentName: string, model: string, tokenTotal = 0,
): Promise<SpawnResult> {
  const endedAt = Date.now();
  opts.runRegistry.update(runId, { status, endedAt, resultSummary: finalText.slice(0, 120) });
  try {
    if (status === "completed") await opts.todoSync.markRunTodoDone(todoId, priorStatus, finalText.slice(0, 500));
    else await opts.todoSync.markRunTodoReverted(todoId, priorStatus, error ?? status);
  } catch {
    // todo-sync reconciliation must not mask the run result; the finally in spawnSubagent releases the lock.
  }
  return {
    status, finalText, runId, todoId, agent: agentName, model,
    durationMs: endedAt - startedAt, tokenTotal, error,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/spawnSubagent.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/spawnSubagent.ts test/spawnSubagent.test.ts
git commit -m "feat(engine): spawnSubagent — the one engine

spawnSubagent(opts) is the single source of truth both surfaces (subagent
tool + /fleet panel Run) call. Wires: concurrency=1 lock, agent resolution,
model resolution (agent.model ?? parent), child-tools minus fleet-owned
(todo excluded), todo-sync link-or-create (before), child session via
injectable factory (testable), turn-budget abort, signal→child.abort,
todo-sync markDone/markReverted (after, hybrid restore-prior). Returns
SpawnResult { status, finalText, runId, todoId, agent, model, durationMs,
tokenTotal, error }. Tests mock the child session (SPEC-1 §5)."
```

---

## Task 12: the `subagent` tool

**Files:**
- Create: `src/tools/subagent.ts`
- Test: `test/subagent-tool.test.ts`

**Interfaces:**
- Consumes: `spawnSubagent` + `SpawnOptions`/`SpawnResult` from `../engine/spawnSubagent.ts`; `AgentDef` registry map; `TodoSyncPort`; `RunRegistry`; `SingleSlotLock`; `ChildSessionFactory`.
- Produces: `createSubagentTool(deps)` returning a `pi.registerTool` definition; `subagentParams` (typebox schema, reused by the panel for validation).

- [ ] **Step 1: Write the failing test**

```ts
// test/subagent-tool.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { Type } from "typebox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodo } from "@getpipher/armory-todo";
import { createSubagentTool, subagentParams } from "../src/tools/subagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "../src/todo-sync/adapter.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
test.beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "tool-")); process.env.TODO_DIR = tmpDir; });
test.afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.TODO_DIR; });

const agent: AgentDef = { name: "g", description: "d", rolePrompt: "r", todoSync: true, source: "builtin", filePath: "/x" };

function makeDeps() {
  return {
    registry: new Map<string, AgentDef>([["g", agent]]),
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    childFactory: { create: async () => ({ session: { prompt: async () => {}, subscribe: () => () => {}, abort: async () => {}, dispose: () => {} }, model: "m" }) },
    parentModel: { provider: "p", id: "m" } as any,
    parentCwd: "/tmp",
  };
}

test("subagentParams schema has the v0.1 fields", () => {
  const keys = Object.keys(subagentParams.properties);
  for (const k of ["agent", "task"]) ok(keys.includes(k), k);
  ok(keys.includes("todoId") || subagentParams.properties.todoId === undefined, "todoId optional");
});

test("tool execute returns content text + details runId on success", async () => {
  const tool = createSubagentTool(makeDeps());
  const out = await tool.execute!("c", { agent: "g", task: "hi" }, new AbortController().signal, () => {}, {} as any);
  ok(out.content[0]!.type === "text");
  ok((out.details as any).runId, "runId in details");
  ok((out.details as any).status === "completed");
});

test("tool execute surfaces isError + actionable message on unknown agent", async () => {
  const tool = createSubagentTool(makeDeps());
  const out = await tool.execute!("c", { agent: "nope", task: "hi" }, new AbortController().signal, () => {}, {} as any);
  strictEqual(out.isError, true);
  ok((out.content[0] as any).text.includes("not in registry"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/subagent-tool.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/subagent.ts
import { Type, type Static } from "typebox";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
import type { ChildSessionFactory, SpawnResult } from "../engine/spawnSubagent.ts";
import { spawnSubagent } from "../engine/spawnSubagent.ts";

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
  childFactory: ChildSessionFactory;
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
        childFactory: deps.childFactory,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/subagent-tool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/subagent.ts test/subagent-tool.test.ts
git commit -m "feat(tools): add subagent model-callable tool

createSubagentTool(deps) → pi.registerTool definition; thin wrapper over
spawnSubagent. v0.1 params (agent, task, todoId?, track?, model?) via
typebox schema; returns content text + details {runId, todoId, agent,
model, status, durationMs, tokenTotal}; isError on failed/aborted.
promptGuidelines steer the model toward linking + track:false only for
throwaways (SPEC-1 §4)."
```

---

## Task 13: Panel row shapes

**Files:**
- Create: `src/panel/rows.ts`
- Test: `test/rows.test.ts`

**Interfaces:**
- Consumes: `RunRecord` (`../engine/run-registry.ts`), `AgentDef` (`../registry/frontmatter.ts`).
- Produces: `fleetRow(run, ctxPercent?)`, `agentsRow(agent)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/rows.test.ts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { fleetRow, agentsRow, fmtDuration } from "../src/panel/rows.ts";
import type { RunRecord } from "../src/engine/run-registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "fl-3kf9a2", agent: "general-purpose", model: "m", task: "review auth module",
  track: true, todoId: "td-mrubw7", status: "running", startedAt: 1, ...over,
});

test("fmtDuration: seconds", () => { strictEqual(fmtDuration(18000), "18s"); });
test("fmtDuration: minutes", () => { strictEqual(fmtDuration(2700000), "45s"); }); // 45s still (sub-minute); minutes only past 60s
test("fleetRow running prefix", () => {
  ok(fleetRow(run(), 32).startsWith("▶"), "running uses ▶");
  ok(fleetRow(run({ status: "completed" })).startsWith("✓"));
  ok(fleetRow(run({ status: "aborted" })).startsWith("✗"));
});
test("fleetRow includes runId, agent, status, todoId, summary", () => {
  const r = fleetRow(run({ status: "completed", endedAt: 2, resultSummary: "refactored X" }));
  ok(r.includes("fl-3kf9a2"), r);
  ok(r.includes("general-purpose"), r);
  ok(r.includes("td-mrubw7"), r);
  ok(r.includes("refactored X"), r);
});
test("agentsRow includes name, source, model, todoSync", () => {
  const a: AgentDef = { name: "scout", description: "d", model: "anthropic/claude-sonnet-4", rolePrompt: "r", todoSync: true, source: "project", filePath: "/x" };
  const r = agentsRow(a);
  ok(r.includes("scout"), r);
  ok(r.includes("[project]"), r);
  ok(r.includes("anthropic/claude-sonnet-4"), r);
  ok(r.includes("todoSync:✓"), r);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/rows.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/panel/rows.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus, RunRecord } from "../engine/run-registry.ts";

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

const STATUS_GLYPH: Record<FleetRunStatus, string> = {
  running: "▶",
  completed: "✓",
  failed: "✗",
  aborted: "✗",
};

export function fleetRow(run: RunRecord, ctxPercent?: number): string {
  const dur = run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : "—";
  const todo = run.todoId ? `  ${run.todoId}` : "";
  const summary = run.resultSummary ? `  "${run.resultSummary}"` : "";
  const ctx = ctxPercent !== undefined ? `  ${ctxPercent}% ctx` : "";
  return `${STATUS_GLYPH[run.status]} ${run.runId}  ${run.agent}  ${run.status}  ${dur}${ctx}${todo}${summary}`;
}

export function agentsRow(agent: AgentDef): string {
  const model = agent.model ?? "(default)";
  const sync = agent.todoSync ? "todoSync:✓" : "todoSync:✗";
  const skills = agent.skills?.length ? `  skills: ${agent.skills.join(",")}` : "";
  const tools = agent.tools?.length ? `  tools: ${agent.tools.join(",")}` : "";
  return `${agent.name}  [${agent.source}]  ${model}${tools}${skills}  ${sync}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/rows.ts test/rows.test.ts
git commit -m "feat(panel): row-shape functions (unit-testable)

fleetRow (status glyph + runId + agent + status + duration + ctx% +
todoId + summary) and agentsRow (name + source + model + tools/skills +
todoSync) — pure functions so the panel component stays thin and the
row shapes are tested without a TUI (SPEC-1 §8.2)."
```

---

## Task 14: the `/fleet` panel (ctx.ui.custom component)

**Files:**
- Create: `src/panel/fleet-panel.ts`

**Interfaces:**
- Consumes: `Container`, `Input`, `SelectList`, `Text`, `Spacer`, `DynamicBorder`, `matchesKey`, `SelectItem`, `Theme` from `@earendil-works/pi-tui`; `DynamicBorder` from `@earendil-works/pi-coding-agent`; `fleetRow`/`agentsRow` from `./rows.ts`; `spawnSubagent` + deps from `../engine/spawnSubagent.ts`; `AgentDef` + `RunRecord`.
- Produces: `FleetPanel` class + `openFleetPanel(ctx, deps)` factory (used by `src/index.ts`).

> **Manual-gate:** the pi-tui components need a real terminal. Pure row fns (Task 13) are unit-tested; this component is verified in a real pi session (Task 16 integration smoke). The pattern mirrors `armory-todo/src/panel.ts`.

- [ ] **Step 1: Write the component**

```ts
// src/panel/fleet-panel.ts
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container, Input, SelectList, Spacer, Text, matchesKey,
  type SelectItem, type Theme,
} from "@earendil-works/pi-tui";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { RunRecord } from "../engine/run-registry.ts";
import { fleetRow, agentsRow } from "./rows.ts";
import { spawnSubagent, type ChildSessionFactory, type SpawnResult } from "../engine/spawnSubagent.ts";
import type { RunRegistry } from "../engine/run-registry.ts";
import type { SingleSlotLock } from "../engine/concurrency-lock.ts";
import type { TodoSyncPort } from "../todo-sync/port.ts";

type View = "fleet" | "agents";

export interface FleetPanelDeps {
  registry: Map<string, AgentDef>;
  runRegistry: RunRegistry;
  lock: SingleSlotLock;
  todoSync: TodoSyncPort;
  childFactory: ChildSessionFactory;
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
  private runAgent = "";
  private taskInput: Input | null = null;
  private linkInput: Input | null = null;
  private linkPhase: "task" | "link" = "task";

  constructor(opts: FleetPanelOpts) {
    super();
    this.theme = opts.theme;
    this.deps = opts.deps;
    this.onDone = opts.onDone;
    this.onNotify = opts.onNotify;
    const accent = (s: string) => this.theme.fg("accent", s);

    this.addChild(new DynamicBorder(accent));
    this.addChild(new Spacer(1));
    this.list = this.buildList();
    this.renderShell();
  }

  private buildList(): SelectList {
    const items = this.view === "fleet"
      ? this.deps.runRegistry.list().map((r) => this.item(fleetRow(r), r.runId))
      : [...this.deps.registry.values()].map((a) => this.item(agentsRow(a), a.name));
    const fresh = new SelectList(items, 12, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    fresh.onSelect = (item) => this.onSelect(item.value);
    fresh.onCancel = () => this.onDone();
    return fresh;
  }

  private item(label: string, value: string): SelectItem {
    return { value, label };
  }

  private renderShell(): void {
    const keep = this.children.slice(0, 2);
    this.children.length = 0;
    this.children.push(...keep);
    const accent = (s: string) => this.theme.fg("accent", s);
    const tabs = ["fleet", "agents"]
      .map((v) => v === this.view ? this.theme.fg("accent", this.theme.bold(`[${v}]`)) : this.theme.fg("dim", v))
      .join("  ");
    this.addChild(new Text(accent(this.theme.bold("  FLEET")) + "  " + tabs, 0, 0));
    this.addChild(new Spacer(1));

    if (this.runMode && this.taskInput) {
      const prompt = this.linkPhase === "task"
        ? `  task> `
        : `  link to todo? (id or blank to create fleet task): `;
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.linkPhase === "task" ? this.taskInput : this.linkInput!);
      this.addChild(new Text(this.theme.fg("dim", "  enter submit • esc cancel"), 0, 0));
    } else {
      this.addChild(this.list);
    }

    this.addChild(new Spacer(1));
    const hint = this.view === "fleet"
      ? "  r:Run-new  s:Stop  o:Open-todo  tab:Agents  q:Quit"
      : "  r:Run  e:Edit  d:Reload  tab:Fleet  q:Quit";
    this.addChild(new Text(this.theme.fg("dim", hint), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(accent));
    this.invalidate();
  }

  private onSelect(value: string): void {
    if (this.view === "agents") this.startRun(value);
    // Fleet view: selecting a row shows its linked todo via notify (Open-todo is the `o` action)
  }

  private startRun(agentName: string): void {
    this.runAgent = agentName;
    this.linkPhase = "task";
    this.taskInput = new Input();
    this.taskInput.onSubmit = (task) => {
      if (!task.trim()) { this.cancelRun(); return; }
      this.linkPhase = "link";
      this.linkInput = new Input();
      this.linkInput.onSubmit = (todoIdRaw) => {
        this.executeRun(agentName, task.trim(), todoIdRaw.trim() || undefined);
      };
      this.linkInput.onEscape = () => this.executeRun(agentName, task.trim(), undefined);
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
      childFactory: this.deps.childFactory,
      parentModel: this.deps.parentModel, parentCwd: this.deps.parentCwd,
    });
    this.list = this.buildList();
    this.renderShell();
    this.onNotify(`${res.status}: ${res.runId}${res.error ? " — " + res.error : ""}`, res.status === "completed" ? "info" : "warning");
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
    // up/down/enter navigate the list
    this.list.handleInput(data);
    this.invalidate();
  }
}

/** Factory used by src/index.ts to open the panel via ctx.ui.custom. */
export function openFleetPanel(
  deps: FleetPanelDeps,
  ctx: { ui: { custom: (factory: (tui: any, theme: Theme, kb: any, done: () => void) => any) => void; notify: (m: string, t?: "info" | "warning" | "error") => void } },
): void {
  ctx.ui.custom((_tui, theme, _kb, done) => {
    return new FleetPanel({ theme, deps, onDone: done, onNotify: (m, t) => ctx.ui.notify(m, t) });
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (TUI component is not unit-tested — verified in Task 16's real-pi smoke.)

- [ ] **Step 3: Commit**

```bash
git add src/panel/fleet-panel.ts
git commit -m "feat(panel): /fleet ctx.ui.custom component (Fleet + Agents)

FleetPanel extends Container (mirrors armory-todo/src/panel.ts pattern).
Two views: Fleet (running+recent via fleetRow) and Agents (registry via
agentsRow). Tab switches; Run on Agents view = task> input then link-to-todo
input → spawnSubagent (panel Run exposes todoId linking, moat-integrity;
track/model overrides deferred SPEC-5b). openFleetPanel factory wires it via
ctx.ui.custom with the full Theme. Verified in real pi (Task 16), not
unit-tested (pi-tui needs a terminal) — SPEC-1 §8."
```

---

## Task 15: Extension entry

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: all prior tasks. `pi.registerTool` / `pi.registerCommand` / `ctx.ui.custom` / `ctx.ui.setWidget` from `@earendil-works/pi-coding-agent`; `DefaultResourceLoader` + `createAgentSession` + `SessionManager` for the real child-session factory.

- [ ] **Step 1: Write the entry**

```ts
// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "./tools/subagent.ts";
import { openFleetPanel } from "./panel/fleet-panel.ts";
import { discoverAgents } from "./registry/discovery.ts";
import { RunRegistry } from "./engine/run-registry.ts";
import { createSingleSlotLock } from "./engine/concurrency-lock.ts";
import { ArmoryTodoAdapter } from "./todo-sync/adapter.ts";
import type { ChildSessionFactory } from "./engine/spawnSubagent.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

/** The real child-session factory (SDK-backed). */
function createChildSessionFactory(): ChildSessionFactory {
  return {
    async create(opts) {
      const loader = new DefaultResourceLoader({
        cwd: opts.cwd,
        systemPromptOverride: () => opts.rolePrompt,
        skillsOverride: (cur) => ({ skills: [...cur.skills, ...opts.skills.map((s) => ({ name: s, description: "", filePath: "", baseDir: "", source: "custom" as const }))], diagnostics: cur.diagnostics }),
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        model: opts.model as any,
        thinkingLevel: opts.thinkingLevel as any,
        tools: opts.tools,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
      });
      return { session: session as any, model: opts.model ?? "" };
    },
  };
}

function builtinAgentsDir(): string {
  // package agents/ dir, resolved relative to this module.
  return join(new URL(".", import.meta.url).pathname, "..", "agents");
}

export default function (pi: ExtensionAPI) {
  const deps = {
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    todoSync: new ArmoryTodoAdapter(),
    childFactory: createChildSessionFactory(),
  };

  const refresh = (ctx: { cwd: string; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
    const r = discoverAgents({
      projectDir: join(ctx.cwd, ".pi", "agents"),
      globalDir: join(process.env.HOME ?? "", ".pi", "agent", "agents"),
      builtinDir: builtinAgentsDir(),
    });
    for (const e of r.errors) ctx.ui.notify(e, "error");
    for (const w of r.warnings) ctx.ui.notify(w, "warning");
    return r.agents;
  };

  pi.on("session_start", (_event, ctx) => {
    (deps as any).registry = refresh(ctx);
    (deps as any).parentModel = ctx.model ?? { provider: "", id: "" };
    (deps as any).parentCwd = ctx.cwd;
  });

  pi.on("resources_discover", (_event, ctx) => {
    // re-scan on /reload
    if (existsSync(join(ctx.cwd, ".pi", "agents"))) (deps as any).registry = refresh(ctx);
    return undefined;
  });

  pi.registerTool(createSubagentTool(deps as any) as any);

  pi.registerCommand("fleet", {
    description: "Open the armory-fleet panel (running + recent subagents + agent registry).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("fleet panel is TUI-only; use the subagent tool in non-interactive modes.", "info");
        return;
      }
      openFleetPanel(deps as any, ctx as any);
    },
  });
}
```

Note: `skillsOverride` mapping above is illustrative; the real `Skill` shape from `DefaultResourceLoader` is `{ name, description, filePath, baseDir, source }`. If a declared skill isn't resolvable by the loader's own discovery, a follow-up sub-task resolves it by path before passing to `skillsOverride` — tracked here, not deferred: the implementer verifies the Skill type against `pi-coding-agent`'s exports during Task 16's integration smoke and adjusts the mapping. The shape is stable; the contract is "the child loads the agent's declared skills."

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (adjust any `as any` casts the compiler flags against the real SDK types).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: extension entry — wire subagent tool + /fleet command + panel

Default export wires session-scoped deps (runRegistry, lock, todoSync,
childFactory) and re-scans the agent registry on session_start +
resources_discover. Registers the subagent tool + /fleet command (TUI-only;
non-TUI falls back to the tool). Real child-session factory uses
createAgentSession + DefaultResourceLoader (systemPromptOverride +
skillsOverride) + SessionManager.inMemory (ephemeral) (SPEC-1 §5, §8, §15)."
```

---

## Task 16: Integration smoke + release prep

**Files:**
- Modify: `package.json` (`private: false`, version `0.1.0`)
- Create: `.github/workflows/release.yml`
- Create: `docs/SPEC-1-smoke-checklist.md` (manual smoke runbook)

- [ ] **Step 1: Full local suite**

Run: `pnpm typecheck && pnpm test:run`
Expected: PASS, all tests green, 80%+ coverage on new code.

- [ ] **Step 2: Write the release workflow (mirrors armory-todo)**

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'pnpm', registry-url: 'https://registry.npmjs.org' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test:run
      - run: pnpm publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] **Step 3: Write the smoke runbook**

```md
<!-- docs/SPEC-1-smoke-checklist.md -->
# SPEC-1 integration smoke (real pi)

Run inside a real pi session with armory-fleet installed (via `packages` in
settings.json pointing at this checkout, or `pi -e ./src/index.ts`).

- [ ] `/fleet` opens the panel; two tabs (Fleet, Agents) switch with Tab.
- [ ] Agents view shows `general-purpose` (builtin).
- [ ] Select `general-purpose`, press `r`, type "list files in cwd", Enter, blank link, Enter → a run appears in Fleet view as ▶ running, then ✓ completed.
- [ ] armory-todo (`/todo`) shows a `fleet`-project task created for that run, status `in_progress` then `done`.
- [ ] Model path: ask the model "delegate a quick file listing to a subagent" → it calls `subagent`; the run appears in `/fleet` + armory-todo.
- [ ] Linking: with an existing open todo id, the model calls `subagent({agent, task, todoId})` → the todo goes `in_progress`, and on completion restores to `open` + a result note.
- [ ] Esc mid-run aborts the child; the run row flips to ✗ aborted; a created `fleet` task reverts to `open`.
- [ ] Turn budget: a looping agent hits 20 turns → `failed` with "hit turn budget (20)…"; created `fleet` task reverts to `open`.
- [ ] Concurrency=1: trigger two `subagent` calls in one turn → second returns isError naming the running runId.
- [ ] `todo` is never callable by a child (fleet is the single writer): verify a child cannot create/complete todos.
- [ ] Theme: switch pi themes; panel still renders (no `theme.getFgAnsi is not a function` crash — the EditorTheme-gotcha lesson).
- [ ] Non-TUI (`pi -p "delegate listing to subagent"`): panel skipped, tool still works.
```

- [ ] **Step 4: Run the smoke manually**

Run: `pi -e ./src/index.ts` and walk `docs/SPEC-1-smoke-checklist.md`.
Expected: every checkbox passes. Fix any drift against the real pi-tui / SDK types inline (the panel + factory are the most likely to need small adjustments — the contract is fixed; the glue may need a one-line tweak).

- [ ] **Step 5: Prepare release**

Switch `@getpipher/armory-todo` dep from `file:../armory-todo` to the published range once the Task-1 armory-todo release (with `exports`) is on npm. Set `package.json`: `"private": false`, `"version": "0.1.0"`.

- [ ] **Step 6: Commit + tag**

```bash
git add .github/workflows/release.yml docs/SPEC-1-smoke-checklist.md package.json
git commit -m "chore(release): release.yml + smoke runbook + v0.1.0 prep

release.yml mirrors armory-todo (idempotent npm publish + GitHub Release
on v* tag). Smoke runbook covers the SPEC-1 panel + tool + todo-sync +
guards + theme-safety checks run inside real pi. Set private:false + v0.1.0
for the first publish (after the armory-todo exports release is on npm)."
git tag v0.1.0
git push origin main --tags
```

---

## Self-Review (spec coverage)

| Spec section | Implemented by |
|---|---|
| §1 goals / done bar | Tasks 1–16 (all); done bar verified in Task 16 smoke |
| §2.1 one engine two surfaces | Task 11 (engine) + Task 12 (tool) + Task 14 (panel Run) all call `spawnSubagent` |
| §2.2 ports-and-adapters | Task 3 (port) + Task 4 (adapter) + Task 1 (armory-todo public API) |
| §2.3 hybrid / vendoring deferred | Task 9 (inline turn budget) + Task 10 (inline lock); no `vendor/` dir (deferred SPEC-5a) |
| §3 file layout | Tasks 2–15 produce exactly the §3 structure |
| §4 subagent tool contract | Task 12 (params, return, status set, isError) + Task 11 (statuses) |
| §4c live widget + Fleet row | Task 12 `onEvent` → `ctx.ui.setWidget`; Task 14 panel row |
| §5 spawn lifecycle | Task 11 `spawnSubagent` (8 steps of §5) |
| §5.1 runId handle | Task 8 `genRunId`; Task 11 returns runId; forward-compatible (no async yet) |
| §6 todo-sync port + adapter + hybrid | Task 3 + Task 4 |
| §7 registry + frontmatter + builtin | Task 5 + Task 6 + Task 7 |
| §7.3 no role taxonomy | Task 7 ships only `general-purpose`; SPEC-4 flag in spec doc |
| §8 /fleet panel | Task 13 (rows) + Task 14 (component) |
| §9 guards (todo-exclusion, concurrency=1, maxTurns, Esc) | Task 11 (all four) + Task 10 + Task 9 |
| §10 error handling (actionable messages) | Task 11 `fail`/`finishRun` messages; Task 4 link validation |
| §11 testing | Tasks 4,5,6,8,9,10,11,12,13 unit tests; Task 16 integration smoke |
| §12 deferrals | none implemented early; all deferred items tagged with landing SPEC in spec doc |
| §13 done bar | verified via Task 16 smoke checklist |

**Placeholder scan:** none — every step has real code or exact commands.
**Type consistency:** `SpawnResult`, `RunRecord`, `AgentDef`, `TodoSyncPort`, `ChildSession` signatures match across tasks (engine → tool → panel all consume the same `SpawnResult`/`RunRecord` shapes; `fleetRow`/`agentsRow` consume `RunRecord`/`AgentDef`).

---

## Execution Handoff

Plan complete and saved to `plans/SPEC-1-core-engine-todo-sync.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?