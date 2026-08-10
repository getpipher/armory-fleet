# SPEC-6-5 CWD Isolation Design

**Date:** 2026-08-08
**Status:** Approved design (brainstorm complete); implementation not started
**Target:** `@getpipher/armory-fleet@0.13.0`
**Branch:** `feat/spec-6-5-cwd-isolation` (to be created)
**Parent issue:** [#20 — subagent tool: no cwd isolation](https://github.com/getpipher/armory-fleet/issues/20)
**Splits from:** PRD §8 SPEC-6-4 (cwd isolation + event-bus RPC + live conversation viewer → v1.0). SPEC-6-5 takes **cwd isolation** as a focused, acute correctness fix that should not wait for the v1.0 coordination feature; SPEC-6-4 retains event-bus RPC + the live conversation viewer, brainstormed separately later.

## 1. Purpose

The `subagent` tool spawns child sessions in the **pi session cwd** (`parentCwd`), not a per-dispatch target. The "Work from: …" prose in the task text is not enforced. A child can therefore read any repo reachable from the session cwd, and — because its `ResourceLoader` context (AGENTS.md cascade, skills, memory) is also scoped to the session cwd — it can **confabulate ownership** of sibling work it merely read (the #20 evidence: a child spawned from a keystone session falsely claimed credit for a parallel session's commit). No cross-repo write occurred in the documented case; the fault was confabulation in the response text.

The fix scopes the child's **context + working directory** to the dispatch target (`cwd`), so the child cannot *see* siblings at the source. This kills the confabulation vector directly and makes the common cross-cwd workflow ("drive project B from a project-A session") correct by construction.

**Out of scope (deferred):** filesystem jail (the child can still `cat ../sibling` via absolute paths — see §2, decision 1). The #20 evidence is confabulation (a context problem), not a real cross-repo write; a partial FS jail (read/write/edit jailed but bash escapable) is *worse* than no jail (false sense of security). Physical isolation already exists as the opt-in `isolation: 'worktree'`.

## 2. Locked decisions (from the brainstorm)

| # | Area | Decision | Alternatives rejected |
|---|---|---|---|
| 1 | **Isolation boundary** | **(A) context-scoping only** — scope the child's context + working dir to the dispatch `cwd`; no FS jail. | (B) context + FS jail — rejected: bash can't be jailed without a container; a partial jail is false security. (C) worktree-by-default — rejected as the *default* (breaks the in-place fg write workflow that is the primary pattern); stays an opt-in lever that already exists. |
| 2 | **Scope** | cwd-pinning (core) **+ user-scope opt-in**. | context-cascade trim — OUT (the parent-dir AGENTS.md cascade is useful org context, not a sibling-bleed vector). tool-set opt-in — DEFER (substrate-minimization, not isolation; negligible post-#42). |
| 3 | **`cwd` param** | Added to the `subagent` tool; **default = session cwd** (backward-compat). Accepts paths outside the session cwd (a sibling) — that's the fix. | — |
| 4 | **Threading** | `childCwd = opts.cwd ?? opts.parentCwd`; child-scoped sites use `childCwd`; session-scoped sites stay `parentCwd`. The **worktree base becomes the child's repo** for cross-cwd `isolation:'worktree'` dispatches. | — |
| 5 | **`cwd` validation** | **(b) validate exists + is a directory** at the tool layer; resolve relative paths against the session cwd; reject with an actionable error before spawning. | (a) no validation (deep opaque spawn crash). (c) require absolute (ergonomic cost). |
| 6 | **Lifecycle `cwd`** | **(ii) per-lifecycle optional `cwd` frontmatter field**; absent → entry-point cwd. | (i) none. (iii) per-phase — YAGNI. |
| 7 | **Panel Run-action** | **(ii) optional 3rd input step** `task → name → cwd` (cwd prefilled with session cwd; Enter to accept). | (i) none (cwd stays implicit — the #47 anti-pattern). |
| 8 | **Cross-cwd surfacing** | `RunRecord.cwd = childCwd` (free via §4) + `run:meta` `sessionCwd` audit field + widget `↗<basename>` glyph + spawn-time `onNotify`. | task-text path-parsing omission guard — OUT (fragile heuristic). |
| 9 | **User-scope opt-in** | **(b) agent-def `userMemory: true` flag, default off.** `memoryHydrate: true` hydrates project+local only; `userMemory: true` adds the user scope. | (a) drop entirely. (c) per-dispatch param — splits memory config across layers. (d) env — too coarse. |

## 3. Architecture

### 3.1 The `cwd` flow (before → after)

**Before (today):** `parentCwd` (the session cwd) is one variable used for both session-scoped and child-scoped concerns.

```
subagent tool → spawnSubagent({ parentCwd }) → factory.create({ cwd: parentCwd })
                                        → buildChildLoader({ cwd: parentCwd })
                                        → createAgentSession({ cwd: parentCwd })
                                        → memoryScopesFor(parentCwd)
                                        → RunRecord.cwd = parentCwd
```

**After:** the tool accepts `cwd`; `childCwd = cwd ?? parentCwd` is threaded to child-scoped sites; `parentCwd` stays for session-scoped sites.

```
subagent tool({ cwd? }) → validate cwd (exists + dir; relative → resolve against parentCwd)
                       → spawnSubagent({ parentCwd, cwd? })
                       → childCwd = opts.cwd ?? opts.parentCwd
                       → factory.create({ cwd: childCwd })
                       → buildChildLoader({ cwd: childCwd, agent })   // cascade, skills, memory scoped to childCwd
                       → createAgentSession({ cwd: childCwd })
                       → memoryScopesFor(childCwd, { includeUser: agent.userMemory ?? false })
                       → RunRecord.cwd = childCwd; run:meta { cwd: childCwd, sessionCwd: parentCwd }
                       → if childCwd !== parentCwd: onNotify(...) + widget glyph
```

### 3.2 Threading split — child-scoped vs session-scoped

| use site | SPEC-6-5 | scope class |
|---|---|---|
| **`RunRecord.cwd` = childCwd** + `run:meta` `cwd` | `childCwd` | child |
| **`RunRecord.sessionCwd`** (new, live) + `run:meta` `sessionCwd` (new) | `parentCwd` | session (audit + live widget glyph) |
| `backend.factory.create({ cwd })` → `createAgentSession` working dir | `childCwd` | child |
| `buildChildLoader({ cwd })` (cascade, skills, memory) | `childCwd` | child |
| `memoryScopesFor(cwd)` (project/local/user) | `childCwd` | child |
| `resolveAdditionalSkillPaths({ cwd })` (`<cwd>/.agents/skills`) | `childCwd` | child |
| worktree base repo (`isolation:'worktree'`) | `childCwd` (worktree of the child's repo) | child |
| `SessionManager.create(cwd)` (session-file location) | `childCwd` | child |
| fleet dir `.pi/fleet/` location | `parentCwd` | session |
| `parentCwd` fallback default passed to `spawnSubagent` | `parentCwd` | session |

**Behavior change to flag:** for a cross-cwd dispatch with `isolation:'worktree'`, the worktree is branched from the *child's* git repo (today it branches from the session repo). Same-cwd dispatches (the common case) are identical. The worktree's `baseRef` resolution must operate on the child repo's git.

### 3.3 `cwd` validation (tool layer)

In `src/tools/subagent.ts`, before calling `spawnSubagent`:

- if `params.cwd` is provided:
  - resolve relative paths against `deps.parentCwd` (`resolve(parentCwd, cwd)`)
  - `stat` the resolved path; reject with `{ isError: true, error: "cwd does not exist: <path>" }` / `"cwd is not a directory: <path>"` if missing or not a dir
  - pass the resolved absolute path to `spawnSubagent` as `cwd`
- if omitted: `cwd` is `undefined` → `childCwd = parentCwd` (the backward-compat default)

This mirrors the existing `isolation:'worktree'`-needs-a-git-repo fail-fast pattern (actionable error at the tool layer, not a deep spawn-time crash).

### 3.4 Lifecycle `cwd` field

`LifecycleDef` gains an optional `cwd?: string` frontmatter field (parsed in `src/lifecycle/registry.ts`). Semantics:

- present + absolute → use as the lifecycle's `cwd` (validated exists + dir, same as the tool)
- present + relative → resolve against the entry-point cwd (the session cwd)
- absent → the entry-point cwd (session cwd for the panel; the `subagent` tool's `cwd`/`parentCwd` for model-driven lifecycle dispatches)

`runLifecycle` threads this `cwd` to its `spawn` adapter calls. **Precedence:** a lifecycle `cwd` field, if present, overrides the entry-point cwd (so a deploy lifecycle pinned to a repo runs in that repo regardless of where it was dispatched); absent → the entry-point cwd (the panel's chosen cwd, or the `subagent` tool's `cwd`/`parentCwd` for model-driven dispatches). All phases share the resolved lifecycle `cwd` (per-phase `cwd` is out of scope). The lifecycle run record carries `cwd` for the Runs tab + audit.

### 3.5 Panel Run-action — 3rd input step

`startLifecycleRun` today: `task → name → executeLifecycleRun`. SPEC-6-5 adds a `cwd` step:

```
task → name → cwd (Input prefilled with deps.parentCwd; Enter to accept, or type a path)
```

The `cwd` Input:
- prefilled/default = `deps.parentCwd` (Enter accepts the session cwd)
- a typed path is resolved + validated (exists + dir) before `executeLifecycleRun`
- Escape at the cwd step → run with the default (session cwd), mirroring the existing **name step's** Escape-accepts-default pattern (`this.lcNameInput.onEscape = () => executeLifecycleRun(task, "default")`); Escape at the task or name step still cancels the run as today
- the chosen `cwd` becomes the **entry-point cwd** passed to `runLifecycle`

This makes the run's scope **visible per run** (the #47 lesson: surface what's implicit) and gives the human a cross-cwd lever without a modal/config.

### 3.6 Cross-cwd surfacing

When `childCwd !== parentCwd`:

- **`run:meta` journal** gains a `sessionCwd` field (the session cwd) alongside the existing `cwd` (now = childCwd). Durable audit/replay can reconstruct the cross-cwd intent.
- **`RunRecord`** carries `cwd` (already = childCwd post-§4) **and a new live `sessionCwd`** (set at spawn = `parentCwd`). The Runs tab already shows `cwd`; `sessionCwd` is live so the widget can compute `crossCwd = cwd !== sessionCwd` without re-reading the journal.
- **Widget row** (`src/panel/widget-rows.ts`): append ` ↗<basename(childCwd)>` after the task excerpt on cross-cwd fg runs. Same-cwd runs: no glyph (no noise on the common case).
  - `▶ "task"  ↗armory-fleet  · agent  5s  575K tok  59% substrate  $0.01`
- **Spawn-time notify**: `onNotify("scoped to <childCwd> (≠ session <parentCwd>)", "info")` when cross-cwd. Immediate feedback at dispatch.

The omission case (model omits `cwd` → childCwd = session cwd) produces **no warning** by design — catching it would require fragile task-text path parsing (legitimate references to other repos would false-positive). The explicit cross-cwd case is fully surfaced; the omission case is backward-compat (the child runs in the session cwd, the pre-SPEC-6-5 behavior).

### 3.7 User-scope opt-in

`AgentDef` gains `userMemory?: boolean` (default `false`), parsed in `src/registry/frontmatter.ts`. The memory hydration semantics become:

| `memoryHydrate` | `userMemory` | scopes hydrated |
|---|---|---|
| `false` | (ignored) | none |
| `true` (default) | `false`/absent (default) | **project + local** (user dropped) |
| `true` | `true` | project + local + user (explicit opt-in) |

`memoryScopesFor(cwd, { includeUser })` returns `{ project: cwd, local: dirname(cwd), ...(includeUser ? { user: USER_PSEUDO_CWD } : {}) }`. The `MemoryScopes.user` field becomes optional in `src/memory-hydrate/port.ts`; `ArmoryMemoryAdapter.renderScopes` already skips empty/absent scopes (`listMemory(cwd).length > 0` filter). `buildChildLoader` passes `includeUser: opts.agent.userMemory ?? false`.

**Backward-incompat:** anyone who populated `~/.pi/agent/memory/-__armory-fleet-user__/` and relied on it hydrating must add `userMemory: true` to their agent def. The measurement (2026-08-08) showed the dir is **absent on the dev machine** (0 tok), and the #20 concern is that the user scope is a cross-project bleed *by construction* — so default-off is the correct, honest change. Documented in the spec + a migration note in the PR.

## 4. Components & files

| file | change |
|---|---|
| `src/tools/subagent.ts` | add `cwd?` to the schema + validation (exists/dir, relative resolve); thread to `spawnSubagent`; spawn-time notify on cross-cwd |
| `src/engine/spawnSubagent.ts` | accept `cwd?: string`; compute `childCwd = cwd ?? parentCwd`; thread `childCwd` to all child-scoped sites (§3.2); keep `parentCwd` for session-scoped; journal `sessionCwd` |
| `src/engine/child-loader.ts` | `buildChildLoader({ cwd, agent, memoryPort })` already uses `cwd`; `memoryScopesFor(cwd, { includeUser: agent.userMemory ?? false })` |
| `src/memory-hydrate/port.ts` | `MemoryScopes.user` → optional |
| `src/memory-hydrate/adapter.ts` | no change (already skips empty scopes) |
| `src/registry/frontmatter.ts` | parse `userMemory` (default false) |
| `src/lifecycle/lifecycle-types.ts` | `LifecycleDef.cwd?: string` |
| `src/lifecycle/registry.ts` | parse `cwd` frontmatter |
| `src/lifecycle/run-lifecycle.ts` | thread lifecycle `cwd` to the `spawn` adapter |
| `src/panel/fleet-panel.ts` | `startLifecycleRun` 3rd input step (cwd) |
| `src/panel/widget-rows.ts` | `↗<basename>` glyph on cross-cwd fg runs |
| `src/runtime/run-log.ts` | `RunMetaEvent.sessionCwd?: string` |
| `src/engine/run-registry.ts` | `RunRecord.sessionCwd?: string` (live; set at spawn = `parentCwd`) |
| `src/backend/registry.ts` + pi-factory (`src/index.ts`) | worktree base resolves against `childCwd` for cross-cwd `isolation:'worktree'` |
| tests | `test/spawnSubagent.test.mts` (cwd threading + childCwd), `test/subagent-tool` (validation + notify), `test/child-loader.test.mts` (userMemory opt-in), `test/widget-rows.test.mts` (↗ glyph), `test/run-lifecycle` (lifecycle cwd), `test/fleet-panel` (3rd input step) |

## 5. Error handling

- **invalid `cwd`** (tool layer): `{ isError: true, error: "cwd does not exist: <path>" | "cwd is not a directory: <path>" }` — fails fast before spawning, actionable.
- **cross-cwd worktree base not a git repo**: `isolation:'worktree'` against a non-git `childCwd` falls back to in-place (existing `'auto'` behavior) with a notify.
- **lifecycle `cwd` invalid**: rejected at lifecycle-run start with an actionable error (same validation as the tool).
- **panel `cwd` input invalid**: re-prompt with the error message; don't run.

## 6. Testing

- **cwd threading**: a dispatch with `cwd` ≠ session cwd → `RunRecord.cwd` + `run:meta.cwd` = childCwd; `run:meta.sessionCwd` = parentCwd; `buildChildLoader`/`memoryScopesFor` called with childCwd (spy/mock).
- **default (omitted cwd)**: `childCwd === parentCwd` (backward-compat byte-identical); no cross-cwd glyph/notify.
- **validation**: nonexistent path → actionable error, no spawn; relative path → resolved against session cwd; non-dir → error.
- **user-scope opt-in**: `memoryHydrate: true, userMemory: false` → `memoryScopesFor` omits user; `userMemory: true` → includes user; `memoryHydrate: false` → no scopes (unchanged).
- **widget glyph**: cross-cwd fg run → `↗<basename>` present; same-cwd → absent.
- **lifecycle cwd**: lifecycle with `cwd` field → phases spawn in that cwd; absent → entry-point cwd.
- **panel 3rd input**: the cwd step prefills session cwd; a typed path is validated + threaded.
- **worktree base (cross-cwd)**: `isolation:'worktree'` with a cross-cwd `cwd` → worktree of the child's repo (regression test for the behavior change).
- **release-gate smoke**: a cross-cwd builtin dispatch produces a non-null result + the run record carries the child cwd.

## 7. Rollout

- Branch `feat/spec-6-5-cwd-isolation`; one PR (or a small stack if the lifecycle/panel pieces grow).
- `pnpm typecheck` + `pnpm test:run` (BOTH) before every commit.
- Read-only review subagent before merge (dogfood `readOnly:true` + `modelFallback`).
- Tag `v0.13.0` (annotated `git tag -a`); release via CI on `v*` tag. Bump the settings pin (dotfiles symlink — `readlink` first).
- Migration note in the PR: `userMemory: true` required for explicit user-scope hydration (default-off flip).

## 8. Out of scope / deferred

- **Filesystem jail** (B) — needs a container/chroot to close the bash gap; a different, larger SPEC if a real cross-repo write ever occurs.
- **Worktree-by-default for fg writes** (C) — stays opt-in (`isolation:'worktree'`); flipping the default would break the in-place fg workflow.
- **Per-phase `cwd`** — YAGNI; per-lifecycle `cwd` covers the use case.
- **Task-text omission guard** — fragile heuristic; the explicit cross-cwd case is fully surfaced, the omission case is backward-compat.
- **Context-file cascade trim** — the parent-dir AGENTS.md cascade is useful org context, not a bleed vector.
- **Tool-set opt-in** — substrate-minimization, not isolation; negligible post-#42. Deferred to a later substrate SPEC if ever warranted.
- **Event-bus RPC + live conversation viewer** — remain SPEC-6-4 (v1.0), brainstormed separately.

## 9. Open questions (none blocking implementation)

- Should the `subagent` tool's `cwd` param be surfaced in the `details` return (so the orchestrator model can read back which cwd a run used)? **Lean yes** (cheap, aids the model's self-correction). Decide at plan time.
- Should the cross-cwd notify be `info` or `warning`? **Lean `info`** (it's an explicit, intended action, not a problem). Decide at plan time.

---

**References:**
- Issue #20: subagent tool: no cwd isolation
- Measurement (2026-08-08): `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-fleet/substrate-measurement-2026-08-08.md`
- Dogfood gotcha #1: `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-fleet/dogfood-gotchas.md`
- Parent roadmap: `PRD.md` §8 (SPEC-6-4)