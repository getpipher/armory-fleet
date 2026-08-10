# SPEC-6-5 CWD Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope each subagent child's context + working directory to a per-dispatch `cwd` (default = session cwd), killing the #20 confabulation vector at the source, and make the cross-project user-memory scope opt-in (`userMemory: true`, default off).

**Architecture:** Add a `cwd` param to the `subagent` tool (default session cwd); compute `childCwd = cwd ?? parentCwd`; thread `childCwd` to all child-scoped sites (factory.create, buildChildLoader, memoryScopesFor, RunRecord.cwd, worktree base) while `parentCwd` stays for session-scoped sites (fleet dir, audit `sessionCwd`). Add `userMemory` (agent frontmatter, default off) gating the user memory scope. Add per-lifecycle `cwd` + a panel Run-action 3rd input step. Surface cross-cwd via a widget `↗<basename>` glyph + spawn-time notify.

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build step), `typebox` for schemas, `node:test` + `node:assert/strict` for tests, pi-coding-agent SDK (`createAgentSession`, `DefaultResourceLoader`), `@getpipher/armory-memory`.

**Spec:** [`docs/superpowers/specs/2026-08-08-spec-6-5-cwd-isolation-design.md`](../specs/2026-08-08-spec-6-5-cwd-isolation-design.md)

## Global Constraints

- Raw `.ts` via tsx at runtime — **no build step**. `pnpm typecheck` + `pnpm test:run` (BOTH) before every commit.
- Tests live in `test/*.test.mts` (NOT co-located in `src/`); `pnpm test:run` only scans `test/`. Import from `../src/...`.
- One branch/PR for the whole SPEC (`feat/spec-6-5-cwd-isolation`); one commit per task. `git tag -a v0.13.0 -m "..."` (NEVER plain `git tag` — GPG/Vim-hang gotcha). Release via CI on `v*` tag.
- `~/.pi/agent/settings.json` is a symlink to `~/dotfiles/pi/agent/settings.json`; `sed -i` fails on the symlink — `readlink` it first.
- edit tool gotcha: multi-edit arrays with backticks/`=>`/nested quotes intermittently fail to serialize. Use `write` for new files / full rewrites; single small `edit` calls for targeted changes.
- Read-only review subagent before merge (dogfood `readOnly:true` + `modelFallback: anthropic/claude-sonnet-4`).
- No AI attribution in commits. GPG key `BF47B9DC1FA320FA`.

---

## File Structure

| file | responsibility | task |
|---|---|---|
| `src/registry/frontmatter.ts` | parse `userMemory` (default false) | T1 |
| `src/memory-hydrate/port.ts` | `MemoryScopes.user` → optional | T2 |
| `src/engine/child-loader.ts` | `memoryScopesFor(cwd, { includeUser })`; `buildChildLoader` wires `agent.userMemory` | T2 |
| `src/runtime/run-log.ts` | `RunMetaEvent.sessionCwd?` | T3 |
| `src/engine/run-registry.ts` | `RunRecord.sessionCwd?` (live) | T3 |
| `src/engine/spawnSubagent.ts` | accept `cwd?`; compute + thread `childCwd`; journal `sessionCwd` | T4 |
| `src/tools/subagent.ts` | `cwd?` schema + validation + cross-cwd notify | T5 |
| `src/index.ts` | worktree base resolves against `childCwd` for cross-cwd `isolation:'worktree'` | T6 |
| `src/panel/widget-rows.ts` | `↗<basename>` glyph on cross-cwd fg runs | T7 |
| `src/lifecycle/lifecycle-types.ts` | `LifecycleDef.cwd?` | T8 |
| `src/lifecycle/registry.ts` | parse lifecycle `cwd` | T8 |
| `src/lifecycle/run-lifecycle.ts` | thread lifecycle `cwd` to the `spawn` adapter | T8 |
| `src/panel/fleet-panel.ts` | `startLifecycleRun` 3rd input step (cwd) | T9 |
| `package.json` + settings pin | bump `0.12.5` → `0.13.0` | T10 |

**Dependency order:** T1 → T2; T3 → T4 → T5; T4 → T6; T4 → T7; T8 (independent of T4 for parse, but threads cwd via the spawn adapter which calls spawnSubagent → exercise after T4); T9 (after T8); T10 (last).

---

### Task 1: `userMemory` frontmatter field

**Files:**
- Modify: `src/registry/frontmatter.ts`
- Test: `test/frontmatter.test.mts` (create if absent; else append)

**Interfaces:**
- Produces: `AgentDef.userMemory?: boolean` (default `false`). Consumed by T2's `buildChildLoader`.

- [ ] **Step 1: Write the failing test**

Append to `test/frontmatter.test.mts` (create the file with the header below if it doesn't exist):

```ts
// test/frontmatter.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { parseAgentFile } from "../src/registry/frontmatter.ts";

const FILE = "/tmp/agent.md";

test("userMemory defaults to false when absent", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\n---\nrole", FILE);
  strictEqual(a.userMemory, false, "userMemory defaults false");
});

test("userMemory: true parses true", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\nuserMemory: true\n---\nrole", FILE);
  strictEqual(a.userMemory, true);
});

test("userMemory: false parses false", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\nuserMemory: false\n---\nrole", FILE);
  strictEqual(a.userMemory, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -i userMemory`
Expected: FAIL — `a.userMemory` is `undefined` (property does not exist on `AgentDef`).

- [ ] **Step 3: Write minimal implementation**

In `src/registry/frontmatter.ts`:

Add to the `AgentDef` interface (after the `vision: boolean;` line):
```ts
  /** #20/SPEC-6-5: opt in to the global cross-project user memory scope (`/__armory-fleet-user__`).
   *  Default false — the user scope is a cross-project bleed by construction; hydrate it only when
   *  an agent explicitly declares `userMemory: true`. Only meaningful when `memoryHydrate: true`. */
  userMemory: boolean;
```

In `parseAgentFile`, near the `memoryHydrate`/`vision` parses (after the `vision` line):
```ts
  const userMemory = raw.userMemory === undefined ? false : Boolean(raw.userMemory);
```

In the returned object literal, add (after `vision,`):
```ts
    userMemory,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "userMemory|tests|pass|fail"`
Expected: 3 userMemory tests PASS; total count rises by 3; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/registry/frontmatter.ts test/frontmatter.test.mts
git commit -m "feat(registry): parse userMemory frontmatter field (SPEC-6-5 T1)"
```

---

### Task 2: `memoryScopesFor` `includeUser` + port + buildChildLoader wiring

**Files:**
- Modify: `src/memory-hydrate/port.ts`
- Modify: `src/engine/child-loader.ts`
- Test: `test/child-loader.test.mts`

**Interfaces:**
- Consumes: `AgentDef.userMemory` (T1).
- Produces: `memoryScopesFor(cwd, opts?: { includeUser?: boolean })` returns `{ project, local, ...(includeUser ? { user } : {}) }`; `MemoryScopes.user` is optional. `buildChildLoader` passes `includeUser: opts.agent.userMemory`.

- [ ] **Step 1: Write the failing test**

Append to `test/child-loader.test.mts`:

```ts
import { memoryScopesFor, USER_PSEUDO_CWD, buildChildLoader } from "../src/engine/child-loader.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "g", description: "d", rolePrompt: "r", todoSync: true, memoryHydrate: true,
  vision: false, backend: "pi", sessionKey: "g", source: "builtin", filePath: "/tmp/g.md",
  userMemory: false, ...over,
});

test("memoryScopesFor omits user by default", () => {
  const s = memoryScopesFor("/repo");
  strictEqual(s.project, "/repo");
  strictEqual(s.local, "/");
  ok(s.user === undefined, "user omitted unless includeUser");
});

test("memoryScopesFor includes user when includeUser: true", () => {
  const s = memoryScopesFor("/repo", { includeUser: true });
  strictEqual(s.user, USER_PSEUDO_CWD);
});
```

(Adjust the `local` assertion if `dirname("/repo")` on your platform is `/` — keep it; the test pins the behavior.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "memoryScopesFor|tests|pass|fail"`
Expected: FAIL — `s.user` is `USER_PSEUDO_CWD` (current behavior always includes user) → `ok(s.user === undefined)` fails.

- [ ] **Step 3: Write minimal implementation**

In `src/memory-hydrate/port.ts`, make `user` optional:
```ts
export interface MemoryScopes {
  project: string;
  local: string;
  /** Optional — only present when the agent opted in via `userMemory: true` (SPEC-6-5).
   *  The user scope is a cross-project memory bleed by default; omitted unless explicitly enabled. */
  user?: string;
}
```

In `src/engine/child-loader.ts`, change `memoryScopesFor`:
```ts
/** Build the memory scopes for a child: project=cwd, local=parent dir; user only when opted in.
 *  #20/SPEC-6-5: the user pseudo-scope (`/__armory-fleet-user__`) is a cross-project bleed by
 *  construction — omit it unless the agent declares `userMemory: true`. */
export function memoryScopesFor(cwd: string, opts?: { includeUser?: boolean }): { project: string; local: string; user?: string } {
  return { project: cwd, local: dirname(cwd) || cwd, ...(opts?.includeUser ? { user: USER_PSEUDO_CWD } : {}) };
}
```

In `buildChildLoader`, change the `memoryBlock` line:
```ts
  const scopes = memoryScopesFor(opts.cwd, { includeUser: opts.agent.userMemory ?? false });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "memoryScopesFor|tests|pass|fail"`
Expected: both memoryScopesFor tests PASS; 0 fail. Also run `pnpm typecheck` (the `user?` optional change may surface callers that assumed `user` — fix any by treating it as optional).

- [ ] **Step 5: Commit**

```bash
git add src/memory-hydrate/port.ts src/engine/child-loader.ts test/child-loader.test.mts
git commit -m "feat(memory): user memory scope opt-in via userMemory (SPEC-6-5 T2)"
```

---

### Task 3: `RunRecord.sessionCwd` + `RunMetaEvent.sessionCwd`

**Files:**
- Modify: `src/engine/run-registry.ts`
- Modify: `src/runtime/run-log.ts`
- Test: `test/run-log.test.mts` (append); `test/run-registry.test.mts` (append, if exists; else `test/run-log.test.mts` covers both)

**Interfaces:**
- Produces: `RunRecord.sessionCwd?: string` (live; set at spawn = `parentCwd`). `RunMetaEvent.sessionCwd?: string`. Consumed by T4 (sets them), T7 (widget reads `RunRecord.sessionCwd` to compute cross-cwd).

- [ ] **Step 1: Write the failing test**

Append to `test/run-log.test.mts`:

```ts
import { RunLog } from "../src/runtime/run-log.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("RunRecord + run:meta carry sessionCwd (SPEC-6-5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rl-"));
  const log = new RunLog(dir);
  const reg = new RunRegistry();
  reg.add({ runId: "fl-x", agent: "g", model: "m", task: "t", track: false, todoId: null,
    status: "running", startedAt: 1, cwd: "/child", sessionCwd: "/session", backend: "pi" });
  const rec = reg.get("fl-x")!;
  strictEqual(rec.cwd, "/child", "child cwd");
  strictEqual(rec.sessionCwd, "/session", "session cwd");
  log.append("fl-x", { type: "run:meta", runId: "fl-x", agent: "g", model: "m", task: "t",
    startedAt: 1, track: false, todoId: null, cwd: "/child", sessionCwd: "/session" });
  // scanMeta round-trips the fields
  const metas = RunLog.scanMeta(dir);
  strictEqual(metas[0]!.cwd, "/child");
  strictEqual(metas[0]!.sessionCwd, "/session");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "sessionCwd|tests|pass|fail"`
Expected: FAIL — `sessionCwd` is not a known field on `RunRecord`/`RunMetaEvent` (type error / undefined).

- [ ] **Step 3: Write minimal implementation**

In `src/engine/run-registry.ts`, add to `RunRecord` (after the `cwd: string;` field):
```ts
  /** SPEC-6-5: the session cwd the dispatch originated from (live; = parentCwd). Set at spawn.
   *  Lets the widget compute cross-cwd (`cwd !== sessionCwd`) for the ↗ glyph without re-reading
   *  the journal. Live-only counterpart to RunMetaEvent.sessionCwd. */
  sessionCwd?: string;
```

In `src/runtime/run-log.ts`:
- add `sessionCwd?: string;` to `RunMetaEvent` (after `cwd?: string;`);
- add `sessionCwd?: string;` to `RunMeta` (after `cwd?: string;`);
- in the `RunLog` `scanMeta`/meta-construction path, copy `sessionCwd` through (find where `cwd` is copied from the event to `RunMeta` and add `sessionCwd` alongside — grep `cwd:` in this file to find the spots).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "sessionCwd|tests|pass|fail"` && `pnpm typecheck`
Expected: sessionCwd test PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/run-registry.ts src/runtime/run-log.ts test/run-log.test.mts
git commit -m "feat(run-record): add sessionCwd to RunRecord + run:meta (SPEC-6-5 T3)"
```

---

### Task 4: `spawnSubagent` `cwd` + `childCwd` threading

**Files:**
- Modify: `src/engine/spawnSubagent.ts`
- Test: `test/spawnSubagent.test.mts`

**Interfaces:**
- Consumes: `RunRecord.sessionCwd` (T3).
- Produces: `SpawnSubagentOpts.cwd?: string`; the run uses `childCwd = opts.cwd ?? opts.parentCwd` for all child-scoped sites; `RunRecord.cwd = childCwd`, `RunRecord.sessionCwd = parentCwd`; `run:meta` carries both. `backend.factory.create({ cwd: childCwd })`.

- [ ] **Step 1: Write the failing test**

Append to `test/spawnSubagent.test.mts`:

```ts
test("SPEC-6-5: cwd param scopes the child (childCwd) and records sessionCwd", async () => {
  // A dispatch with cwd !== parentCwd → RunRecord.cwd = childCwd, sessionCwd = parentCwd,
  // and the factory.create is called with cwd = childCwd (not the session cwd).
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const child: ChildSession = {
    prompt: async () => { for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }); },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  let createdCwd: string | undefined;
  const factory: ChildSessionFactory = {
    create: async (o) => { createdCwd = o.cwd; return { session: child, model: "m" }; },
  };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false,
    cwd: "/child-target",                       // SPEC-6-5: explicit dispatch target
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock,
    backendRegistry: regWith(h.factory), parentModel: PARENT, parentCwd: "/session",
  });
  strictEqual(res.status, "completed");
  const rec = h.runRegistry.get(res.runId)!;
  strictEqual(rec.cwd, "/child-target", "RunRecord.cwd = childCwd");
  strictEqual(rec.sessionCwd, "/session", "RunRecord.sessionCwd = parentCwd");
  strictEqual(createdCwd, "/child-target", "factory.create received childCwd, not session cwd");
});

test("SPEC-6-5: omitted cwd → childCwd = parentCwd (backward-compat)", async () => {
  const handlers: Array<(e: ChildSessionEvent) => void> = [];
  const child: ChildSession = {
    prompt: async () => { for (const h of handlers) h({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }); },
    subscribe: (h) => { handlers.push(h); return () => {}; }, abort: async () => {}, dispose: () => {},
  };
  let createdCwd: string | undefined;
  const factory: ChildSessionFactory = { create: async (o) => { createdCwd = o.cwd; return { session: child, model: "m" }; } };
  const h = harness(factory);
  const res = await spawnSubagent({
    agent: "g", task: "do", track: false,
    // cwd OMITTED
    registry: h.registry, todoSync: h.todoSync, runRegistry: h.runRegistry, lock: h.lock,
    backendRegistry: regWith(h.factory), parentModel: PARENT, parentCwd: "/session",
  });
  strictEqual(res.status, "completed");
  const rec = h.runRegistry.get(res.runId)!;
  strictEqual(rec.cwd, "/session", "omitted cwd → childCwd = parentCwd");
  strictEqual(rec.sessionCwd, "/session");
  strictEqual(createdCwd, "/session", "factory.create received session cwd");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"`
Expected: FAIL — `cwd` is not a known `SpawnSubagentOpts` field (type error: `Object literal may only specify known properties`).

- [ ] **Step 3: Write minimal implementation**

In `src/engine/spawnSubagent.ts`:

Add `cwd?: string;` to `SpawnSubagentOpts` (after `parentCwd: string;`):
```ts
  /** SPEC-6-5: the dispatch target's working directory. Default = parentCwd (the session cwd,
   *  backward-compat). When set, all child-scoped sites use this cwd (factory.create,
   *  buildChildLoader, memoryScopesFor, RunRecord.cwd, worktree base); session-scoped sites
   *  (fleet dir, audit sessionCwd) keep parentCwd. */
  cwd?: string;
```

Near the top of `spawnSubagent` (after the `const startedAt = Date.now();` / before `opts.runRegistry.add`), compute:
```ts
  // SPEC-6-5: childCwd = explicit dispatch cwd ?? session cwd. The child's working dir + context
  //  (cascade, skills, memory) scope to childCwd; session-scoped concerns (fleet dir, audit
  //  sessionCwd) keep parentCwd.
  const childCwd = opts.cwd ?? opts.parentCwd;
```

In the `opts.runRegistry.add({...})` call, change `cwd: opts.parentCwd` → `cwd: childCwd` and add `sessionCwd: opts.parentCwd,`:
```ts
    opts.runRegistry.add({
      runId, agent: agentDef.name, model, task: opts.task, track,
      todoId: null, status: "running", startedAt,
      tier: tier?.name, costTotal: 0, contextTokens: 0,
      cwd: childCwd, sessionCwd: opts.parentCwd, backend: backendId,
    });
```

In the `backend.factory.create({...})` call, change `cwd: opts.parentCwd` → `cwd: childCwd`.

In the `run:meta` append, change `cwd: opts.parentCwd` → `cwd: childCwd` and add `sessionCwd: opts.parentCwd`:
```ts
          opts.runLog?.append(runId, { type: "run:meta", runId, agent: agentDef.name, model, task: opts.task, startedAt, track, todoId, backendSessionId: e.backendSessionId, sessionKey: agentDef.sessionKey, cwd: childCwd, sessionCwd: opts.parentCwd, pid: (session as { proc?: { pid?: number } }).proc?.pid });
```

(Leave any `opts.parentCwd` uses that are session-scoped — e.g. the fleet-dir path if present in this file — unchanged. Grep `opts.parentCwd` in `src/engine/spawnSubagent.ts` and confirm each remaining use is session-scoped; the worktree base is handled in T6.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"` && `pnpm typecheck`
Expected: both SPEC-6-5 tests PASS; full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/spawnSubagent.ts test/spawnSubagent.test.mts
git commit -m "feat(spawn): childCwd threading + sessionCwd (SPEC-6-5 T4)"
```

---

### Task 5: `subagent` tool `cwd` param + validation + cross-cwd notify

**Files:**
- Modify: `src/tools/subagent.ts`
- Test: `test/subagent-tool.test.mts` (append; if absent, model the harness on existing tool tests — see `test/` for a tool-harness example)

**Interfaces:**
- Consumes: `SpawnSubagentOpts.cwd` (T4), `SubagentToolDeps.parentCwd`.
- Produces: the tool schema gains `cwd?`; `execute` validates + resolves it, passes `cwd` to `spawnSubagent` (direct + lifecycle + retry paths), and emits `deps.onNotify`... — NOTE: `SubagentToolDeps` has no `onNotify` today. Add `onNotify?: (msg: string, kind?: "info"|"warning"|"error") => void` to `SubagentToolDeps` (wired in `src/index.ts` from `ctx.ui.notify`); emit it when `resolvedCwd !== parentCwd`.

- [ ] **Step 1: Write the failing test**

Append to `test/subagent-tool.test.mts` (create a minimal harness that constructs `createSubagentTool(deps)` + calls `execute`; mirror an existing tool test for the deps shape). The assertions:

```ts
test("SPEC-6-5: tool rejects a nonexistent cwd", async () => {
  const tool = createSubagentTool(harness.deps({ parentCwd: "/session" }));
  const res = await tool.execute("id", { agent: "g", task: "do", cwd: "/no/such/dir" }, new AbortController().signal, null as any, null as any);
  ok(res.isError, "nonexistent cwd → isError");
  ok((res as any).content[0].text.includes("cwd does not exist"), `actionable error: ${(res as any).content[0].text}`);
});

test("SPEC-6-5: tool resolves a relative cwd against the session cwd", async () => {
  const seen: string[] = [];
  const tool = createSubagentTool(harness.deps({ parentCwd: "/session", onSpawnCwd: (c) => seen.push(c) }));
  await tool.execute("id", { agent: "g", task: "do", cwd: "child" }, new AbortController().signal, null as any, null as any);
  ok(seen[0] === "/session/child", `relative cwd resolved against session: ${seen[0]}`);
});

test("SPEC-6-5: cross-cwd dispatch fires onNotify", async () => {
  const notes: string[] = [];
  const tool = createSubagentTool(harness.deps({ parentCwd: "/session", onNotify: (m) => notes.push(m) }));
  await tool.execute("id", { agent: "g", task: "do", cwd: "/other" }, new AbortController().signal, null as any, null as any);
  ok(notes.some((n) => n.includes("scoped to") && n.includes("/other")), `cross-cwd notify: ${notes.join("|")}`);
});
```

(Adapt `harness.deps` to the actual test harness in the file; if no harness exists yet, build a minimal one: a `SubagentToolDeps` with a mocked `runRegistry`/`lock`/`backendRegistry`/`registry`/`todoSync` + a `spawnSubagent` stubbed via the backend factory returning a canned `ChildSession`. The existing `test/spawnSubagent.test.mts` harness is a good reference for the deps shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"`
Expected: FAIL — `cwd` is not in the schema (the dispatch reaches spawnSubagent with no cwd / or type error).

- [ ] **Step 3: Write minimal implementation**

In `src/tools/subagent.ts`:

Add `onNotify?` to `SubagentToolDeps` (after `defaultModelFallback?: string;`):
```ts
  /** SPEC-6-5: notify hook for cross-cwd dispatch surfacing. Wired from ctx.ui.notify in index.ts. */
  onNotify?: (message: string, kind?: "info" | "warning" | "error") => void;
```

Add `cwd` to `subagentParams`:
```ts
  cwd: Type.Optional(Type.String({ description: "The dispatch target's working directory. Default: the session cwd (backward-compat). Scoped to this path: the child's working dir, context-file cascade, skill discovery, and memory scopes. Accepts paths OUTSIDE the session cwd (a sibling repo) — that's the #20 fix. Relative paths resolve against the session cwd." })),
```

Add a validation helper near `mergeLifecycleSkills`:
```ts
import { resolve, statSync } from "node:path";
/** SPEC-6-5: validate + resolve a dispatch cwd. Returns { cwd } on success or { error } on failure. */
export function resolveDispatchCwd(raw: string | undefined, parentCwd: string): { cwd?: string; error?: string } {
  if (raw === undefined || raw === "") return { cwd: undefined };   // default → parentCwd
  const abs = resolve(parentCwd, raw);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return { error: `cwd is not a directory: ${abs}` };
    return { cwd: abs };
  } catch {
    return { error: `cwd does not exist: ${abs}` };
  }
}
```

At the top of `execute`, before the background/schedule/lifecycle routing, validate cwd once:
```ts
      const { cwd: resolvedCwd, error: cwdErr } = resolveDispatchCwd(params.cwd, deps.parentCwd);
      if (cwdErr) return { isError: true, content: [{ type: "text" as const, text: cwdErr }] };
      // SPEC-6-5: cross-cwd surfacing (explicit dispatch to a cwd ≠ the session).
      if (resolvedCwd && resolvedCwd !== deps.parentCwd) {
        deps.onNotify?.(`scoped to ${resolvedCwd} (≠ session ${deps.parentCwd})`, "info");
      }
```

Then thread `cwd: resolvedCwd` into every `spawnSubagent({...})` call in `execute` (the lifecycle `spawn` adapter, the primary direct call, AND the retry call). For the lifecycle path, also thread `cwd: resolvedCwd` through the `spawn` adapter's `spawnSubagent` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"` && `pnpm typecheck`
Expected: 3 SPEC-6-5 tool tests PASS; full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/subagent.ts test/subagent-tool.test.mts
git commit -m "feat(tool): cwd param + validation + cross-cwd notify (SPEC-6-5 T5)"
```

Wire `onNotify` in `src/index.ts` where `createSubagentTool(deps)` is constructed (add `onNotify: (m, k) => ctx.ui.notify(m, k)` to the deps literal). No test for the wiring (integration), but typecheck must pass.

---

### Task 6: Worktree base resolves against `childCwd`

**Files:**
- Modify: `src/index.ts` (the worktree creation path for `isolation:'worktree'`)
- Test: `test/index-worktree.test.mts` (or the existing worktree test file — grep `test/` for `worktree`)

**Interfaces:**
- Consumes: the `childCwd` threaded by T4 (the factory's `opts.cwd`).
- Produces: a cross-cwd `isolation:'worktree'` dispatch branches the worktree from the *child's* git repo, not the session repo.

- [ ] **Step 1: Write the failing test**

Find the existing worktree test (e.g. `test/worktree*.test.mts` or in `test/index.test.mts`). Add a test that asserts the worktree `cwd` passed to `createWorktree`/`createAgentSession` is the child cwd when the dispatch specifies `cwd !== parentCwd`. If the worktree helper is unit-tested in isolation (a `createWorktree(cwd, baseRef)` function), assert it receives the child cwd.

```ts
test("SPEC-6-5: worktree base uses childCwd for cross-cwd isolation:'worktree'", async () => {
  // When a dispatch is cross-cwd AND isolation:'worktree', the worktree is created from the
  // CHILD's git repo (not the session repo). Assert the worktree helper receives childCwd.
  // (Adapt to the actual createWorktree signature in src/index.ts or the worktree module.)
  const captured: string[] = [];
  // ... harness wiring that captures the cwd passed to worktree creation ...
  // dispatch with cwd: "/child-repo", isolation: "worktree", parentCwd: "/session"
  ok(captured.includes("/child-repo"), `worktree created from child repo: ${captured.join("|")}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5 worktree|tests|pass|fail"`
Expected: FAIL — the worktree is created from `parentCwd` today.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts`, find the worktree-creation path used by `isolation:'worktree'` (grep `createWorktree` / `worktreePath`). Ensure the `cwd` passed to worktree creation is `opts.cwd` (the factory's `opts.cwd` = childCwd from T4), not the session cwd. If the worktree helper currently receives the session cwd from a closure, rebind it to `opts.cwd`.

(If the worktree is created *before* `createAgentSession` in a path that doesn't yet see `opts.cwd`, thread `opts.cwd` to that path — the factory's `create:` already receives `cwd: opts.cwd` from T4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5 worktree|tests|pass|fail"` && `pnpm typecheck`
Expected: worktree test PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-worktree.test.mts
git commit -m "fix(worktree): base worktree on childCwd for cross-cwd isolation (SPEC-6-5 T6)"
```

---

### Task 7: Widget `↗<basename>` glyph on cross-cwd fg runs

**Files:**
- Modify: `src/panel/widget-rows.ts`
- Test: `test/widget-rows.test.mts`

**Interfaces:**
- Consumes: `RunRecord.sessionCwd` (T3) → `WidgetRun.sessionCwd`.
- Produces: `WidgetRun.sessionCwd?`; `toWidgetRun` threads it; `widgetLine` appends ` ↗<basename(cwd)>` when `cwd && sessionCwd && cwd !== sessionCwd`.

- [ ] **Step 1: Write the failing test**

Append to `test/widget-rows.test.mts`:

```ts
import { basename } from "node:path";

test("SPEC-6-5: cross-cwd fg run shows the ↗<basename> glyph", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", startedAt: 1000, task: "do", cwd: "/Users/r/projB", sessionCwd: "/Users/r/projA" } as any));
  const lines = renderWidgetLines([w as any], 2000);
  ok(lines[0]!.includes(`↗${basename("/Users/r/projB")}`), `cross-cwd glyph: ${lines[0]}`);
});

test("SPEC-6-5: same-cwd fg run has no ↗ glyph", () => {
  const w = toWidgetRun(fg({ runId: "fl-x", startedAt: 1000, task: "do", cwd: "/session", sessionCwd: "/session" } as any));
  const lines = renderWidgetLines([w as any], 2000);
  ok(!lines[0]!.includes("↗"), `same-cwd → no glyph: ${lines[0]}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"`
Expected: FAIL — `WidgetRun` has no `sessionCwd`; no glyph rendered.

- [ ] **Step 3: Write minimal implementation**

In `src/panel/widget-rows.ts`:

Add `import { basename } from "node:path";` at the top.

Add to `WidgetRun` (after `contextTokens?: number;` or near the cwd-related fields):
```ts
  /** SPEC-6-5: the session cwd (parentCwd). When cwd !== sessionCwd the widget shows a ↗ glyph. */
  sessionCwd?: string;
  /** SPEC-6-5: the run's (child) cwd — already on RunRecord; surfaced to WidgetRun for the glyph. */
  cwd?: string;
```

In `toWidgetRun`, thread both:
```ts
    sessionCwd: r.sessionCwd, cwd: r.cwd,
```

In `widgetLine`, after the `ctx` computation + before `cost`, add (fg only — inside the fg branch, after the `substrate` block):
```ts
  // SPEC-6-5: cross-cwd glyph — when the run's cwd differs from the session cwd, mark it so the
  // operator sees "this run is scoped to a different project" at a glance. Same-cwd → no glyph.
  const crossCwd = (r.cwd && r.sessionCwd && r.cwd !== r.sessionCwd) ? `  ↗${basename(r.cwd)}` : "";
```

Insert `${crossCwd}` into the fg return string (after the task label, before `agentSeg` — `▶ "task"  ↗armory-fleet  · agent …`):
```ts
  return `${glyph} ${label}${crossCwd}${agentSeg}${dur}${liveness}${tok}${ctx}${substrate}${cost}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"` && `pnpm typecheck`
Expected: both glyph tests PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/panel/widget-rows.ts test/widget-rows.test.mts
git commit -m "feat(widget): cross-cwd ↗ glyph on fg runs (SPEC-6-5 T7)"
```

---

### Task 8: Lifecycle `cwd` field + parse + thread (precedence)

**Files:**
- Modify: `src/lifecycle/lifecycle-types.ts`
- Modify: `src/lifecycle/registry.ts`
- Modify: `src/lifecycle/run-lifecycle.ts`
- Modify: `src/tools/subagent.ts` (the lifecycle `spawn` adapter passes the resolved lifecycle cwd)
- Test: `test/lifecycle-registry.test.mts`; `test/run-lifecycle.test.mts`

**Interfaces:**
- Consumes: `SpawnSubagentOpts.cwd` (T4).
- Produces: `LifecycleDef.cwd?: string`; `runLifecycle` resolves `lifecycleCwd = lifecycle.cwd ?? entryPointCwd` and threads it to each `deps.spawn({ ..., cwd: lifecycleCwd })`; precedence: lifecycle `cwd` field > entry-point cwd.

- [ ] **Step 1: Write the failing test**

Append to `test/lifecycle-registry.test.mts`:
```ts
test("SPEC-6-5: parses lifecycle cwd field", () => {
  const lc = parseLifecycleFile("---\nname: deploy\ndescription: d\nbackend: pi\ncwd: /target-repo\nphases:\n  - name: p\n    skills: []\n---\n## p\ntemplate\n", "/tmp/deploy.md", "builtin");
  strictEqual(lc.cwd, "/target-repo");
});
test("SPEC-6-5: lifecycle cwd optional (absent → undefined)", () => {
  const lc = parseLifecycleFile("---\nname: deploy\ndescription: d\nbackend: pi\nphases:\n  - name: p\n    skills: []\n---\n## p\ntemplate\n", "/tmp/deploy.md", "builtin");
  ok(lc.cwd === undefined, "absent cwd → undefined");
});
```

Append to `test/run-lifecycle.test.mts`:
```ts
test("SPEC-6-5: lifecycle cwd overrides entry-point cwd in spawn calls", async () => {
  const spawnedCwds: string[] = [];
  const deps = lifecycleHarness({
    spawn: async (o) => { spawnedCwds.push((o as any).cwd); return { status: "completed", finalText: "", runId: "fl-x", todoId: null, agent: "g", model: "m", durationMs: 1 } as any; },
    lifecycle: { name: "lc", description: "d", backend: "pi", phases: [{ name: "p", skills: [], promptTemplate: "t", checkpoint: false }], source: "builtin", filePath: "/tmp/lc.md", cwd: "/lifecycle-target" } as any,
  });
  await runLifecycle("task", "lc", { deps, mode: "auto", onCheckpoint: async () => ({ action: "continue" }), entryCwd: "/session" });
  ok(spawnedCwds.every((c) => c === "/lifecycle-target"), `phases spawned in lifecycle cwd: ${spawnedCwds.join("|")}`);
});
```
(Adapt `lifecycleHarness` to the actual harness in the file; `entryCwd` is a new `LifecycleRunOpts` field — see Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"`
Expected: FAIL — `LifecycleDef.cwd` doesn't exist; `LifecycleRunOpts.entryCwd` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/lifecycle/lifecycle-types.ts`, add to `LifecycleDef` (after `backend: BackendId;`):
```ts
  /** SPEC-6-5: pin this lifecycle to a target working directory. Absent → the entry-point cwd
   *  (the panel's chosen cwd, or the dispatching `subagent` tool's cwd/session cwd). When present,
   *  overrides the entry-point cwd for all phases. */
  cwd?: string;
```

In `src/lifecycle/registry.ts`, parse it (near `backend`):
```ts
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : undefined;
```
Return it: `return { name, description, backend, phases, source, filePath, ...(cwd ? { cwd } : {}) };`

In `src/lifecycle/run-lifecycle.ts`, add to `LifecycleRunOpts`:
```ts
  /** SPEC-6-5: the entry-point cwd (the panel's chosen cwd, or the dispatching subagent tool's
   *  cwd/session cwd). The lifecycle's `cwd` field, if present, overrides this. Resolved lifecycle
   *  cwd is threaded to every `deps.spawn` call. */
  entryCwd?: string;
```
At the top of `runLifecycle`, resolve:
```ts
  const lifecycleDef = deps.registry.get(lifecycleName)!;
  const lifecycleCwd = lifecycleDef.cwd ?? opts.entryCwd;
```
Thread `cwd: lifecycleCwd` into every `deps.spawn({...})` call in the phase loop. (`PhaseSpawnOpts` gains `cwd?: string` — add it to the interface in this file.)

In `src/tools/subagent.ts`, the lifecycle `spawn` adapter (inside `withModelFallbackRetry`) — `spawnSubagent` already receives `cwd` via the T5 threading, BUT for lifecycle dispatches the cwd should be the *lifecycle-resolved* cwd. Since `runLifecycle` resolves `lifecycleCwd` and passes it to `deps.spawn`, and `deps.spawn` calls `spawnSubagent({ ..., cwd: o.cwd })`, thread `o.cwd` (the `PhaseSpawnOpts.cwd`) into the `spawnSubagent` call: add `cwd: o.cwd,` to the lifecycle `spawnSubagent({...})`. Also pass `entryCwd: resolvedCwd` to the `runLifecycle({...})` call so the lifecycle's `cwd` field can override it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5|tests|pass|fail"` && `pnpm typecheck`
Expected: all SPEC-6-5 lifecycle tests PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/lifecycle-types.ts src/lifecycle/registry.ts src/lifecycle/run-lifecycle.ts src/tools/subagent.ts test/lifecycle-registry.test.mts test/run-lifecycle.test.mts
git commit -m "feat(lifecycle): per-lifecycle cwd field + precedence (SPEC-6-5 T8)"
```

---

### Task 9: Panel Run-action 3rd input step (cwd)

**Files:**
- Modify: `src/panel/fleet-panel.ts` (`startLifecycleRun` + `executeLifecycleRun`)
- Test: `test/fleet-panel.test.mts` (or the existing panel test)

**Interfaces:**
- Consumes: `runLifecycle`'s `entryCwd` (T8).
- Produces: `startLifecycleRun` adds a 3rd `cwd` Input step (prefilled with `deps.parentCwd`); the chosen cwd is validated + threaded to `executeLifecycleRun` → `runLifecycle({ entryCwd })`.

- [ ] **Step 1: Write the failing test**

Append to the panel test (model the input-step harness on existing panel tests — these typically test `startLifecycleRun` by driving the Input `onSubmit`/`onEscape` callbacks):
```ts
test("SPEC-6-5: panel Run-action adds a cwd input step (default = session cwd)", () => {
  const panel = panelHarness({ parentCwd: "/session" });
  panel.startLifecycleRun();
  // task step
  panel.lcTaskInput!.onSubmit("do task");
  // name step
  panel.lcNameInput!.onSubmit("default");
  // cwd step (3rd) — exists + prefilled
  ok(panel.lcCwdInput !== null && panel.lcCwdInput !== undefined, "cwd input step exists");
  // Enter accepts the default (session cwd)
  panel.lcCwdInput!.onSubmit("");
  // assert runLifecycle was called with entryCwd: "/session"
  ok(lastRunLifecycleArgs()?.entryCwd === "/session", "default cwd = session cwd");
});

test("SPEC-6-5: panel cwd step Escape accepts the default (mirrors name step)", () => {
  const panel = panelHarness({ parentCwd: "/session" });
  panel.startLifecycleRun();
  panel.lcTaskInput!.onSubmit("do task");
  panel.lcNameInput!.onSubmit("default");
  panel.lcCwdInput!.onEscape();
  ok(lastRunLifecycleArgs()?.entryCwd === "/session", "Escape → default session cwd");
});

test("SPEC-6-5: panel typed cwd is threaded + validated", () => {
  const panel = panelHarness({ parentCwd: "/session" });
  panel.startLifecycleRun();
  panel.lcTaskInput!.onSubmit("do task");
  panel.lcNameInput!.onSubmit("default");
  panel.lcCwdInput!.onSubmit("/other-repo");   // a real dir in the test fixture
  ok(lastRunLifecycleArgs()?.entryCwd === "/other-repo", "typed cwd threaded");
});
```
(Adapt `panelHarness` + `lastRunLifecycleArgs` to the actual panel test harness; if the panel tests drive via a mocked `runLifecycle`, capture the `entryCwd` arg.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5 panel|tests|pass|fail"`
Expected: FAIL — `lcCwdInput` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/panel/fleet-panel.ts`:

Add fields to the panel class (near `lcTaskInput`/`lcNameInput`):
```ts
  private lcCwdInput: Input | null = null;
```

In `startLifecycleRun`, add the cwd step after the name step's `onSubmit`:
```ts
      this.lcNameInput.onSubmit = (name: string) => {
        const lcName = name.trim() || "default";
        this.lcPhase = "cwd";
        this.lcCwdInput = new Input();
        this.lcCwdInput.onSubmit = (cwd: string) => {
          const picked = cwd.trim() || this.deps.parentCwd;
          void this.executeLifecycleRun(task.trim(), lcName, picked);
        };
        this.lcCwdInput.onEscape = () => { void this.executeLifecycleRun(task.trim(), lcName, this.deps.parentCwd); };
        this.renderShell();
      };
      this.lcNameInput.onEscape = () => { void this.executeLifecycleRun(task.trim(), "default", this.deps.parentCwd); };
```
(Update `cancelLifecycleRun` to clear `lcCwdInput` too.)

Change `executeLifecycleRun(task, lifecycleName)` → `executeLifecycleRun(task, lifecycleName, cwd: string)`. Validate cwd (exists + dir) at the top; on invalid, `onNotify(...)` + return (don't run). Thread `entryCwd: cwd` into the `runLifecycle({...})` call. (For the `spawn` adapter inside, T8 already threads `o.cwd`; the panel's `entryCwd` is the fallback the lifecycle `cwd` field overrides.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run 2>&1 | grep -iE "SPEC-6-5 panel|tests|pass|fail"` && `pnpm typecheck`
Expected: all 3 panel cwd tests PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/panel/fleet-panel.ts test/fleet-panel.test.mts
git commit -m "feat(panel): Run-action cwd input step (SPEC-6-5 T9)"
```

---

### Task 10: Migration note + v0.13.0 bump + settings pin

**Files:**
- Modify: `README.md` (migration note)
- Modify: `package.json` (`0.12.5` → `0.13.0`)
- Modify: `~/dotfiles/pi/agent/settings.json` (via `readlink`, pin `@0.12.5` → `@0.13.0`)

- [ ] **Step 1: Add the migration note to README**

Add a `## Migration (v0.13.0)` section:
```md
## Migration (v0.13.0 — SPEC-6-5 cwd isolation)

- **`userMemory` default flip:** the global cross-project user memory scope (`/__armory-fleet-user__`) is no longer hydrated by default. If you populated that dir and relied on it, add `userMemory: true` to the agent frontmatter (only meaningful with `memoryHydrate: true`).
- **`cwd` param:** the `subagent` tool accepts an optional `cwd` (default = the session cwd). Cross-cwd dispatches are surfaced with a `↗<basename>` widget glyph + a spawn-time notify.
- **Lifecycle `cwd`:** lifecycles accept an optional `cwd` frontmatter field to pin a target repo; absent → the entry-point cwd.
```

- [ ] **Step 2: Bump package.json + settings pin**

```bash
# package.json
# (edit "version": "0.12.5" → "0.13.0" via a single edit call)
# settings pin (resolve the symlink first)
SETTINGS=$(readlink ~/.pi/agent/settings.json)
# edit the armory-fleet pin in $SETTINGS from @0.12.5 → @0.13.0 via a single edit call
```

- [ ] **Step 3: Final verification**

Run: `pnpm typecheck && pnpm test:run 2>&1 | grep -iE "tests|pass|fail"`
Expected: typecheck clean; full suite green.

- [ ] **Step 4: Read-only review subagent before merge**

Dispatch a read-only review subagent over the whole branch (`git diff main...HEAD`) with `readOnly:true` + `modelFallback: anthropic/claude-sonnet-4`. Address any Critical/Important findings.

- [ ] **Step 5: Merge + tag + release**

```bash
git push -u origin feat/spec-6-5-cwd-isolation
gh pr create --base main --title "feat: SPEC-6-5 cwd isolation (#20)" --body-file <PR-body-file>
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only
git tag -a v0.13.0 -m "SPEC-6-5: cwd isolation + userMemory opt-in"
git push origin v0.13.0   # CI publishes to npm + GitHub release
```

- [ ] **Step 6: Commit**

```bash
git add README.md package.json
git commit -m "chore: bump to v0.13.0 + migration note (SPEC-6-5 T10)"
```
(The settings pin commit lives in `~/dotfiles` — commit it there separately: `cd ~/dotfiles && git add pi/agent/settings.json && git commit -m "chore(pi): pin armory-fleet @0.13.0"`.)

---

## Self-Review (run after writing)

- **Spec coverage:** every §2 locked decision maps to a task: D1 boundary (T4/T6 — no FS jail), D2 scope (T1/T2 userMemory; cascade trim + tool-set explicitly out), D3 cwd param (T5), D4 threading (T4), D5 validation (T5), D6 lifecycle cwd (T8), D7 panel input (T9), D8 surfacing (T3/T7/T5 notify), D9 userMemory (T1/T2). ✓
- **Placeholder scan:** no TBD/TODO/"add appropriate error handling" — every code step shows the code. The panel/lifecycle test harnesses reference "adapt to the actual harness" because the harness shape depends on the existing test file; the implementer reads the file. Acceptable (the assertions are concrete).
- **Type consistency:** `childCwd` (T4) → `cwd` on `PhaseSpawnOpts` (T8) → `o.cwd` in the spawn adapter (T8); `sessionCwd` (T3) → `WidgetRun.sessionCwd` (T7); `userMemory` (T1) → `agent.userMemory` (T2); `entryCwd` (T8) → panel `executeLifecycleRun(cwd)` (T9). ✓
- **Gaps:** none. T6's worktree test harness is the least-detailed (the worktree creation path in `src/index.ts` needs runtime inspection by the implementer — flagged in the task).