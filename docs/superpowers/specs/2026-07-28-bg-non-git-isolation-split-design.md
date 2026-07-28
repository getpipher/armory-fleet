# v0.11.1 — Background dispatch isolation split (non-git cwd fix)

**Date:** 2026-07-28
**Type:** Patch / bugfix (not a roadmap SPEC)
**Package:** `@getpipher/armory-fleet` · target release `0.11.1` (patch)
**Predecessor:** v0.11.0 (SPEC-6-2 — quality gates + lifecycle hooks; `main` `cda5e2b`, 438/438 tests)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context — the bug

### Symptom
Firing background `subagent` runs (`background: true`) in a non-git cwd (e.g. `~/local-dev/bug-bounty`, a bucket folder with no `.git`) produces **100% failure**. Seven parallel research dispatches all die with:

```
fleet run fl-ms4tmqq0-… failed: worktree create failed for run fl-ms4tmqq0-… (base HEAD):
  fatal: not a git repository (or any of the parent directories): .git
```

The model, having received `background run: fl-…` for each (looks successful), then polls `fleet_results` for ~90s waiting for runs that already died. Reproduced in pi session `019fa956-96c9-7bb2-a98a-bccaf2783d67` (`~/local-dev/bug-bounty`).

### Root cause — two compounding problems

**1. Worktree isolation is conflated with background execution.** `runBackground()` (`src/runtime/async-runner.ts:84`) **unconditionally** calls `WorktreeService.create()` → `git worktree add`, which requires a git repo. SPEC-5a built `runBackground` as an "isolated-edit-background-runner" (worktree create → `runLifecycle` with `worktreePath` → diff-service artifact discovery → `git commit` on completion → remove worktree). That whole shape assumes an *editing* run on an *isolated branch* — so it breaks in non-git cwds. But background execution and worktree isolation are **orthogonal concerns**:
- **Background execution** = fire-and-forget + pool-gated concurrency + journal + inbox + notify. Git-agnostic.
- **Worktree isolation** = isolated edit surface for parallel edits + auto-commit-to-branch. Requires git. An *editing* concern.

A read-only research agent in a non-git bucket should background fine; worktree is overhead it doesn't need and a hard dependency it can't satisfy. Foreground `subagent` (no `background`) already runs in-place in `ctx.cwd` with no worktree (`spawnSubagent.ts` has zero worktree refs) — so the asymmetry is **background-only**.

**2. The failure is async and invisible to the model.** `runBackground` returns `{ runId, status: "background" }` **synchronously**, *before* worktree creation runs (worktree creation is inside `void deps.pool.withSlot(async () => …)` — fire-and-forget). The tool returns `background run: fl-…` (looks successful), then the pool's async block catches the git error and surfaces it only via `ctx.ui.notify(...)` — a **TUI toast the model never sees as a tool result**. From the model's view, all dispatches "succeeded"; it waits for results that will never come. This is a bug **independent of the non-git case** — any worktree-creation failure surfaces as an async toast, not a tool error.

### What this patch closes
- The non-git 100%-failure (the headline).
- The async-toast-invisible-to-the-model failure pattern (synchronous fail-fast on worktree failures).
- The architectural conflation (worktree stops being a mandatory property of "background"; becomes an opt-in mode) — which is the seam SPEC-6-3's `agent()` `isolation` opt-in will inherit.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | Fix model | **Proper architectural split** — separate background-execution (git-agnostic) from worktree-isolation (requires git) as two functions, not a flag on one. Same LOC, honest boundaries; the 6-3 `agent()` `isolation` seam falls out for free. |
| 2 | `isolation` default | **`auto`** — isolated when `ctx.cwd` is a git repo (current behavior preserved for editing lifecycles), in-place when not (enables the non-git case). Existing model calls in git repos are unchanged. |
| 3 | Interrupted in-place run on restart | **abort + notify** — consistent with how `reconcile`/`scanResumeCandidates` already aborts interrupted *isolated* runs (worktree-missing → abort). In-place runs have no worktree to clean; partial edits may remain in the cwd (honest). |
| 4 | `auto`-fallback warning cadence | **per-session dedup** — first `auto`→in-place fallback in a session notifies "background run in-place (no worktree isolation — parallel edits may conflict)"; subsequent are silent. 7 parallel runs → 1 toast. |
| 5 | `auto` pre-flight mechanism | **`WorktreeService.isGitRepo()`** helper (`git rev-parse --show-toplevel` succeeds) — one cheap sync call before returning the runId; gates `auto` routing + the `"worktree"` synchronous fail. |
| 6 | Scheduler | scheduled runs gain optional `isolation` (default `auto`); same plumbing as the tool. |
| 7 | Release | patch v0.11.1, branch `fix/spec-bg-non-git`, commit prefix `fix(bg): …`. |

## 3. Architecture — the split

### `src/runtime/async-runner.ts` (the bulk of the change)

Two functions where there was one:

```
runBackgroundInPlace(task, opts)              # the git-agnostic core
  pool.withSlot:
    journal run:started (NO worktree field)
    runLifecycle(task, lifecycle, { mode, worktreePath: undefined })   # in ctx.cwd
    on completed: inbox.push(result with NO branch); notify; journal run:completed (NO branch)
    on failed/aborted: journal run:aborted; notify; emitProgress failed

runBackgroundIsolated(task, opts)            # the worktree wrapper
  # SYNCHRONOUS pre-flight (before returning any handle):
  if !worktree.isGitRepo(cwd):
    return { status: "failed", error: "isolation: 'worktree' requires a git repo; cwd '…' is not one — use isolation: 'none' or run in a git repo" }   # NO runId — tool maps to isError
  runId = deps.genRunId()                       # generate only after pre-flight passes
  wt = worktree.create(runId, baseRef)         # synchronous; failure here → same failed shape
  void runBackgroundInPlace(runId, task, opts WITH { worktreePath: wt.path, artifactDiscovery: diff-service, onCompleted: commit+remove })
  return { runId, status: "background" }
```

**Return contract:** the router returns a union — `{ runId, status: "background" }` (success; the run is now fire-and-forget in the pool) **or** `{ status: "failed", error }` (synchronous pre-flight/worktree failure; **no runId**). The `subagent` tool maps the latter to `{ isError: true, content: [{ text: error }] }` so the model receives an actionable tool result, not an async toast. `runBackgroundInPlace` (the core) always succeeds at dispatch (no git dependency) so it stays fire-and-forget and returns `{ runId, status: "background" }`.

The wrapper threads three things into the core: `worktreePath` (for `runLifecycle`'s isolated artifact discovery), `artifactDiscovery` (the diff-service), and an `onCompleted` hook (`git commit` the worktree, then `removeWorktree`). The core stays unchanged in shape; the wrapper adds the isolation lifecycle around it.

**Synchronous fail-fast** is the key correctness property: `runBackgroundIsolated` does its pre-flight + worktree creation **before** returning, so a worktree failure is a tool `isError`, not an async toast. `runBackgroundInPlace` can't fail at dispatch (no git dependency) so it stays fire-and-forget.

**The `auto` router** (one sync `isGitRepo()` call) picks the function. The `subagent` tool calls the router; the scheduler's `onFire` calls the router.

### Files touched

| File | Change |
|---|---|
| `src/runtime/async-runner.ts` | split `runBackground` → `runBackgroundInPlace` (core) + `runBackgroundIsolated` (wrapper) + `runBackgroundAuto` router; add `isolation` to `RunBackgroundOpts`; synchronous pre-flight in the isolated path |
| `src/worktree/worktree-service.ts` | add `isGitRepo(dir?: string): boolean` (`git rev-parse --show-toplevel` succeeds); used by the `auto` router + the `"worktree"` sync-fail |
| `src/runtime/run-journal.ts` | `RunStartedEvent.worktree?` optional; `RunCompletedEvent.branch?` optional (in-place runs have neither). Additive — old events still parse. |
| `src/runtime/resume.ts` | `scanResumeCandidates` handle missing `worktree` field: an interrupted in-place run (no `started.worktree`) → abort + notify (no worktree to clean); `ResumeCandidate.worktreePath?`/`branch?` optional |
| `src/tools/subagent.ts` | add `isolation: "worktree" \| "none" \| "auto"` param (default `auto`); route through `runBackgroundAuto`; `"worktree"`-in-non-git returns synchronous `isError` |
| `src/index.ts` | scheduler `onFire` threads `isolation` (default `auto`); wire `WorktreeService.isGitRepo` into the router; per-session in-place-fallback notify dedup (module-level flag) |
| `src/runtime/async-runner.test.mts` | in-place in non-git (the bug case); isolated in git (regression); `worktree`-in-non-git sync error; `auto` routing; interrupted in-place abort |
| `src/tools/subagent.test.mts` (if present) / `src/runtime/resume.test.mts` | isolation param routing + sync error; in-place interrupted abort |
| `src/runtime/run-journal.test.mts` | optional `worktree`/`branch` round-trip |

### Type additions

```ts
// run-journal.ts
interface RunStartedEvent  { type: "run:started";  runId: string; task: string; lifecycle: string;
  worktree?: { path: string; branch: string }; mode: "auto" | "checkpointed"; ts: number; }   // worktree now optional
interface RunCompletedEvent { type: "run:completed"; runId: string; branch?: string; ts: number; }  // branch now optional

// async-runner.ts
type Isolation = "worktree" | "none" | "auto";
interface RunBackgroundOpts { deps: AsyncRunnerDeps; lifecycle: string; mode: "auto" | "checkpointed"; isolation?: Isolation; }  // default "auto"

// subagent tool
isolation: Type.Optional(Type.Union([
  Type.Literal("worktree"), Type.Literal("none"), Type.Literal("auto"),
], { description: "Edit isolation for background runs. 'worktree' = git worktree (requires a git repo; fails sync if not). 'none' = in-place in cwd (no isolation; parallel edits may conflict). 'auto' (default) = worktree when cwd is a git repo, in-place otherwise." })),

// worktree-service.ts
isGitRepo(dir?: string): boolean;   // git rev-parse --show-toplevel succeeds
```

## 4. Edge cases

| Case | Behavior |
|---|---|
| `auto` in a git cwd | isolated (worktree) — current behavior preserved; no notify |
| `auto` in a non-git cwd | in-place; **one** per-session notify ("background run in-place — no worktree isolation, parallel edits may conflict") |
| `"worktree"` in a non-git cwd | **synchronous `isError`**: "isolation: 'worktree' requires a git repo; cwd '…' is not one — use isolation: 'none' or run in a git repo". Router returns `{ status: "failed", error }` (no runId); tool surfaces `isError`. No async toast, no 90s poll. |
| `"none"` in a git cwd | in-place (skip worktree overhead) — for known read-only runs; no notify (explicit choice) |
| Worktree creation fails for a non-git reason (e.g. disk full) | synchronous `isError` from `runBackgroundIsolated` (worktree.create is now sync, before returning) |
| Interrupted in-place run on restart | abort + notify ("fleet run X interrupted — partial edits may remain in cwd; re-fire to retry"); no worktree to clean |
| Interrupted isolated run on restart | unchanged — worktree-missing → abort (existing `scanResumeCandidates` path) |
| 7 parallel `auto` runs in non-git | 7 in-place runs, 1 notify (per-session dedup) |
| Old journal events (pre-0.11.1, have `worktree`) | parse unchanged (fields are now optional, not removed) |
| Scheduled run (`scheduler.onFire`) | threads `isolation` (default `auto`); scheduled runs usually in git repos → worktree, unchanged |

## 5. What does NOT change

- **Foreground `subagent`** (no `background`) — unchanged; already in-place in `ctx.cwd`.
- **`runLifecycle`** — unchanged; it already accepts optional `worktreePath` (undefined → prompt-baked artifact parser; set → diff-service). The core passes `undefined`; the wrapper passes `wt.path`.
- **`WorktreeService.create/remove/removeWorktree`** — unchanged; just gains `isGitRepo()`.
- **`RunLog`** (the per-agent conversation journal) — untouched (this is the `conversations/` journal; the split is in the `runs/` RunJournal).
- **6-2 gate chain / liveness probe / cross-cwd filter** — untouched.
- **`RunResult.branch?`** — already optional in `results-inbox.ts`; in-place runs push results with no `branch`.

## 6. Scope + release

### IN scope (→ v0.11.1)
- `runBackground` split (core + wrapper + `auto` router)
- `isolation` param on the `subagent` tool (default `auto`) + scheduler
- `WorktreeService.isGitRepo()`
- Synchronous fail-fast on worktree failures (`"worktree"`-in-non-git + any worktree-create failure)
- `RunStartedEvent.worktree?` / `RunCompletedEvent.branch?` optional
- `scanResumeCandidates` handles in-place interrupted runs (abort + notify)
- Per-session in-place-fallback notify dedup
- Tests (TDD)

### NOT in scope
- Resume-in-place of interrupted in-place runs (abort is the v0.11.1 choice; resume-in-place is a future refinement if users want it)
- Exposing `isolation` on the `/fleet` panel action submenu (the panel's Run action doesn't currently set isolation; the model-callable tool is the surface — panel exposure is a 6-3 concern when workflows land)
- SPEC-6-3 workflows-as-code (the `agent()` `isolation` opt-in inherits this seam — separate SPEC)

### Release
| | |
|---|---|
| Target version | `v0.11.1` |
| Branch | `fix/spec-bg-non-git` |
| Commit prefix | `fix(bg): …` |
| Release flow | branch → PR → `gh pr merge --merge --delete-branch` → tag `v0.11.1` → CI publish → bump `settings.json` → term-smoke on published |
| Smoke target | `~/local-dev/bug-bounty` (non-git) — fire a `background: true` subagent there post-patch; expect a working in-place run + 1 notify, not the 100%-fail |
| Compatibility | pi `^0.81.1` (unchanged) |

## 7. Testing strategy

TDD, node:test via tsx, `--test-timeout=30000`. Existing patterns.

### Unit tests (new + extended)

| Test file | Status | Covers |
|---|---|---|
| `src/runtime/async-runner.test.mts` | EXTENDED | in-place in non-git (the bug case — run completes, no worktree, no branch in result); isolated in git (regression — worktree created, commit, branch in result, worktree removed); `isolation:"worktree"` in non-git → sync `isError` (no async toast, no runId returned); `isolation:"auto"` in non-git → in-place + notify; `isolation:"auto"` in git → isolated, no notify; `isolation:"none"` in git → in-place (no worktree); worktree-create failure (non-git-reason) → sync error |
| `src/runtime/run-journal.test.mts` | EXTENDED | `run:started` without `worktree` round-trips; `run:completed` without `branch` round-trips; old events with the fields still parse |
| `src/runtime/resume.test.mts` | EXTENDED | `scanResumeCandidates` with an interrupted in-place run (no `started.worktree`) → abort + notify, no worktree clean; interrupted isolated run unchanged |
| `src/worktree/worktree-service.test.mts` | EXTENDED | `isGitRepo()` true in a git repo, false in a plain dir |
| `src/tools/subagent.test.mts` | EXTENDED | `isolation` param routing (if a tool-level test harness exists; else covered via async-runner + index wiring) |

### Integration / term smoke
- **The bug repro** is the integration smoke: in `~/local-dev/bug-bounty` (non-git), fire `subagent({ task: "list files", background: true })` → expect a working in-place background run (appears in `/fleet`, completes, result in inbox), not the 100%-fail.
- `isolation: "worktree"` in non-git → model receives a synchronous `isError` (not `background run: …`).

### Coverage target
- New code: 80%+ (project standard)
- `runBackgroundIsolated` sync-fail paths: 100% branch (the correctness-critical surface)
- `isGitRepo`: both branches

## 8. References

- Bug session: `~/.pi/agent/sessions/--Users-rector-local-dev-bug-bounty--/2026-07-28T15-27-32-041Z_019fa956-96c9-7bb2-a98a-bccaf2783d67.jsonl`
- Predecessor: `docs/superpowers/specs/2026-07-28-spec-6-2-quality-gates-design.md` (v0.11.0)
- Existing split precedent: `src/lifecycle/run-lifecycle.ts` (the phase loop already accepts optional `worktreePath` — the core/wrapper split mirrors this)
- SPEC-6-3 (inherits the `isolation` seam for `agent()`): `PRD.md` §8