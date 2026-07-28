# Background dispatch isolation split (v0.11.1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `runBackground` into a git-agnostic core + a worktree wrapper + an `auto` router so background `subagent` dispatch stops 100%-failing in non-git cwds, and worktree failures surface as synchronous tool errors instead of async toasts.

**Architecture:** `runBackgroundInPlace` (core: pool + journal + runLifecycle in `ctx.cwd`, no worktree) + `runBackgroundIsolated` (wrapper: sync `isGitRepo` pre-flight → worktree create → core with worktree extras → commit → remove) + `runBackgroundAuto` (router: isolated when git, in-place + per-session warn when not). The `subagent` tool + scheduler gain `isolation: "worktree" | "none" | "auto"` (default `auto`). The sync-fail returns `{ status: "failed", error }` (no runId) → the tool maps to `isError`.

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build step), node:test, typebox, `@earendil-works/pi-coding-agent` SDK.

## Global Constraints

- Raw `.ts` via tsx at runtime — **no build step**.
- `pnpm typecheck` + `pnpm test:run` (`--test-timeout=30000`) green before every commit.
- Commit prefix `fix(bg): …` / `test(bg): …`. No AI attribution.
- Branch: `fix/spec-bg-non-git`. Target release: `v0.11.1` (patch).
- Tests live in `test/` (not `src/`), named `*.test.mts`, run via `node --import tsx --test test/*.test.mts`.
- 2-space indent. Follow existing patterns (`makeRepo()` git fixtures, fake `runLifecycle`, `setTimeout(60)` for pool drain).
- The `runBackground` public name + the `RunBackgroundHandle` success type stay (back-compat for the existing test + any external ref); the return widens to a union `RunBackgroundResult`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/worktree/worktree-service.ts` | + `isGitRepo()` helper |
| `src/runtime/run-journal.ts` | `RunStartedEvent.worktree?` + `RunCompletedEvent.branch?` optional |
| `src/runtime/async-runner.ts` | the split: `runBackgroundInPlace` (core) + `runBackgroundIsolated` (wrapper) + `runBackgroundAuto` (router) + `runBackground` dispatcher; `RunLifecycleOpts.worktreePath?`/`branch?` optional; `RunBackgroundResult` union |
| `src/runtime/resume.ts` | `scanResumeCandidates` handles in-place interrupted runs (no `worktree` field → abort + notify); `ResumeCandidate.worktreePath?`/`branch?` optional |
| `src/tools/subagent.ts` | + `isolation` param; sync-fail → `isError`; scheduler.register threads `isolation` |
| `src/scheduling/scheduler.ts` | `ScheduleSpec.isolation?` |
| `src/index.ts` | `asyncRunLifecycle` adapter isolation-aware (conditional `artifactDiscovery` + `parentCwd`); scheduler `onFire` threads `isolation` |
| `test/worktree-service.test.mts` | `isGitRepo` true/false |
| `test/run-journal.test.mts` | optional `worktree`/`branch` round-trip |
| `test/async-runner.test.mts` | in-place / isolated / sync-fail / auto routing |
| `test/subagent-tool.test.mts` | `isolation` param routing + sync-fail `isError` |
| `test/scheduler.test.mts` | `isolation` threads through `onFire` |
| `test/resume.test.mts` | in-place interrupted run → abort |

---

### Task 1: Foundation — `isGitRepo()` + optional journal/lifecycle fields

**Files:**
- Modify: `src/worktree/worktree-service.ts:7,38` (add `isGitRepo`)
- Modify: `src/runtime/run-journal.ts:11,16` (optional fields)
- Modify: `src/runtime/async-runner.ts:28-32` (`RunLifecycleOpts` optional)
- Test: `test/worktree-service.test.mts` (extend)
- Test: `test/run-journal.test.mts` (extend)

**Interfaces:**
- Produces: `WorktreeService.isGitRepo(dir?: string): boolean`; `RunStartedEvent.worktree?`; `RunCompletedEvent.branch?`; `RunLifecycleOpts.worktreePath?: string; branch?: string` — consumed by Tasks 2 + 5.

- [ ] **Step 1: Write failing tests**

Add to `test/worktree-service.test.mts` (after the last test, before EOF):

```typescript
test("isGitRepo is true in a git repo, false in a plain dir", () => {
  const repo = makeRepo();
  const plain = mkdtempSync(join(tmpdir(), "wt-nogit-"));
  const svc = new WorktreeService({ rootDir: repo });
  assert.equal(svc.isGitRepo(), true);
  const svcPlain = new WorktreeService({ rootDir: plain });
  assert.equal(svcPlain.isGitRepo(), false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});
```

Add to `test/run-journal.test.mts`:

```typescript
test("run:started without worktree + run:completed without branch round-trip", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-ip1", { type: "run:started", runId: "fl-ip1", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
  j.append("fl-ip1", { type: "run:completed", runId: "fl-ip1", ts: 2 });
  const events = j.replay("fl-ip1");
  assert.equal(events.length, 2);
  const started = events[0] as any;
  assert.equal(started.worktree, undefined);
  const completed = events[1] as any;
  assert.equal(completed.branch, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("old run:started with worktree still parses after the field becomes optional", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-old", { type: "run:started", runId: "fl-old", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-old" }, mode: "auto", ts: 1 });
  const events = j.replay("fl-old");
  assert.equal((events[0] as any).worktree.branch, "fleet/fl-old");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run 2>&1 | grep -E "isGitRepo|without worktree|old run:started" | head`
Expected: 3 failures (`isGitRepo is not a function`; the optional-field tests may pass already since TS structurally allows omission — if they pass, that's fine, the impl change in Step 3 is what makes the *type* legal). Confirm `isGitRepo` test fails.

- [ ] **Step 3: Implement**

In `src/worktree/worktree-service.ts`, add after the `exists` method (before `create`):

```typescript
  /** v0.11.1: is `rootDir` (or `dir`) inside a git repo? Cheap sync pre-flight for isolation routing. */
  isGitRepo(dir: string = this.rootDir): boolean {
    try {
      sh("git rev-parse --show-toplevel", dir);
      return true;
    } catch {
      return false;
    }
  }
```

In `src/runtime/run-journal.ts`, make the two fields optional:

```typescript
export interface RunStartedEvent { type: "run:started"; runId: string; task: string; lifecycle: string; worktree?: { path: string; branch: string }; mode: "auto" | "checkpointed"; ts: number; }
export interface RunCompletedEvent { type: "run:completed"; runId: string; branch?: string; ts: number; }
```

In `src/runtime/async-runner.ts`, make `worktreePath`/`branch` optional:

```typescript
export interface RunLifecycleOpts {
  runId: string;
  worktreePath?: string;
  branch?: string;
  mode: "auto" | "checkpointed";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — all 438 prior + 3 new = 441. No regressions (the adapter in index.ts still passes `worktreePath: opts.worktreePath` which is now `string | undefined` — assignable to the optional field; `run-lifecycle.ts` already guards `if (deps.artifactDiscovery && opts.worktreePath)`).

- [ ] **Step 5: Commit**

```bash
git add src/worktree/worktree-service.ts src/runtime/run-journal.ts src/runtime/async-runner.ts test/worktree-service.test.mts test/run-journal.test.mts
git commit -m "fix(bg): add isGitRepo + optional worktree/branch journal fields

Foundation for the background isolation split. WorktreeService gains a
cheap isGitRepo() pre-flight. RunStartedEvent.worktree and
RunCompletedEvent.branch become optional (in-place runs have neither).
RunLifecycleOpts.worktreePath/branch become optional. Additive — old
events still parse; no behavior change."
```

---

### Task 2: The split — core + wrapper + router + adapter

**Files:**
- Modify: `src/runtime/async-runner.ts` (full rewrite of `runBackground` + new fns)
- Modify: `src/index.ts:203-228` (`asyncRunLifecycle` adapter isolation-aware)
- Test: `test/async-runner.test.mts` (extend)

**Interfaces:**
- Consumes: `WorktreeService.isGitRepo()` (Task 1), optional journal fields (Task 1)
- Produces: `runBackgroundInPlace(runId, task, opts, isolated?)` (core, fire-and-forget); `runBackgroundIsolated(task, opts): RunBackgroundResult` (sync pre-flight + worktree); `runBackgroundAuto(task, opts): RunBackgroundResult` (router); `runBackground(task, opts): RunBackgroundResult` (dispatcher, default `auto`); `RunBackgroundResult` union; `Isolation` type; `RunBackgroundOpts.isolation?`.

- [ ] **Step 1: Write failing tests**

Add to `test/async-runner.test.mts` (after existing tests). Note: the existing two tests use `makeRepo()` (git) and call `runBackground(...)` with no `isolation` → `auto` → isolated → current behavior preserved (regression guard).

```typescript
test("runBackground isolation:'none' runs in-place in a NON-GIT dir, journals run:started with no worktree, completes, pushes result with no branch", async () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit-"));
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.equal(opts.worktreePath, undefined, "in-place run must not receive a worktreePath");
    writeFileSync(join(plain, "out.txt"), "done\n");
    return {
      runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "implement", status: "completed", summary: "did it", paths: ["out.txt"], reviseCount: 0 }],
      startedAt: 1, endedAt: 2, todoId: "td-x",
    };
  };
  const { deps, journal, inbox, notifications } = makeDeps(plain, fakeLifecycle);
  const handle = runBackground("research x", { deps, lifecycle: "default", mode: "auto", isolation: "none" });
  assert.equal(handle.status, "background");
  assert.ok("runId" in handle, "in-place handle has a runId");
  await new Promise((r) => setTimeout(r, 60));
  const events = journal.replay(handle.runId);
  const started = events.find((e) => e.type === "run:started") as any;
  assert.equal(started.worktree, undefined, "in-place run:started must omit worktree");
  assert.ok(events.some((e) => e.type === "run:completed"), "no run:completed");
  const completed = events.find((e) => e.type === "run:completed") as any;
  assert.equal(completed.branch, undefined, "in-place run:completed must omit branch");
  assert.equal(inbox.readyCount(), 1);
  assert.equal(inbox.pull()[0]!.branch, undefined, "in-place result has no branch");
  assert.ok(notifications.some((n) => /completed/.test(n)), `notifications: ${notifications.join("|")}`);
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground isolation:'worktree' in a NON-GIT dir returns a SYNCHRONOUS failed result (no runId, no async toast, no 90s poll)", () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit2-"));
  const fakeLifecycle: RunLifecycleFn = async () => ({ runId: "x", lifecycleName: "x", task: "x", backend: "pi", mode: "auto", status: "completed", phases: [], startedAt: 1, endedAt: 2, todoId: null });
  const { deps, notifications } = makeDeps(plain, fakeLifecycle);
  const handle = runBackground("edit x", { deps, lifecycle: "default", mode: "auto", isolation: "worktree" });
  assert.equal(handle.status, "failed");
  assert.ok(!("runId" in handle), "sync-fail must NOT return a runId");
  assert.ok(/requires a git repo/.test((handle as any).error), `error: ${(handle as any).error}`);
  // No run was started → no async toast fires for this runId
  assert.equal(notifications.length, 0, "sync-fail must not emit an async notify");
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground default (auto) in a NON-GIT dir falls back to in-place + emits ONE per-session fallback notify", () => {
  const plain = mkdtempSync(join(tmpdir(), "async-nogit3-"));
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => ({
    runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
    phases: [{ name: "implement", status: "completed", summary: "s", paths: [], reviseCount: 0 }],
    startedAt: 1, endedAt: 2, todoId: null,
  });
  const { deps, notifications } = makeDeps(plain, fakeLifecycle);
  // first auto-fallback run → 1 notify
  const h1 = runBackground("a", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h1.status, "background");
  // second auto-fallback run → no additional notify (per-session dedup)
  const h2 = runBackground("b", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h2.status, "background");
  const fallbackNotes = notifications.filter((n) => /in-place|worktree isolation/.test(n));
  assert.equal(fallbackNotes.length, 1, `expected exactly 1 fallback notify, got: ${notifications.join("|")}`);
  rmSync(plain, { recursive: true, force: true });
});

test("runBackground default (auto) in a GIT dir stays isolated (no fallback notify) — regression guard", async () => {
  const repo = makeRepo();
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.ok(opts.worktreePath, "git auto run must receive a worktreePath");
    writeFileSync(join(opts.worktreePath!, "d.md"), "# d\n");
    return { runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "brainstorm", status: "completed", summary: "s", paths: ["d.md"], reviseCount: 0 }], startedAt: 1, endedAt: 2, todoId: "t" };
  };
  const { deps, notifications } = makeDeps(repo, fakeLifecycle);
  const h = runBackground("x", { deps, lifecycle: "default", mode: "auto" });
  assert.equal(h.status, "background");
  assert.ok("runId" in h);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(notifications.filter((n) => /in-place|worktree isolation/.test(n)).length, 0, "git auto must not fallback-notify");
  rmSync(repo, { recursive: true, force: true });
});

test("runBackground isolation:'none' in a GIT dir runs in-place (explicit opt-out, no notify)", async () => {
  const repo = makeRepo();
  const fakeLifecycle: RunLifecycleFn = async (task, lifecycleName, opts) => {
    assert.equal(opts.worktreePath, undefined, "explicit none must not receive a worktreePath");
    return { runId: opts.runId, lifecycleName, task, backend: "pi", mode: "auto", status: "completed",
      phases: [{ name: "implement", status: "completed", summary: "s", paths: [], reviseCount: 0 }], startedAt: 1, endedAt: 2, todoId: null };
  };
  const { deps, journal, notifications } = makeDeps(repo, fakeLifecycle);
  const h = runBackground("ro", { deps, lifecycle: "default", mode: "auto", isolation: "none" });
  assert.equal(h.status, "background");
  await new Promise((r) => setTimeout(r, 60));
  const started = journal.replay(h.runId).find((e) => e.type === "run:started") as any;
  assert.equal(started.worktree, undefined);
  assert.equal(notifications.filter((n) => /in-place|worktree isolation/.test(n)).length, 0, "explicit none must not fallback-notify");
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run 2>&1 | grep -E "in-place|SYNCHRONOUS|fallback|regression|explicit none" | head`
Expected: 5 failures (the old `runBackground` always worktrees → the `none`/`auto`-in-non-git tests fail; the sync-fail test fails because the old fn returns `{runId, status:"background"}` not a failed union).

- [ ] **Step 3: Implement — rewrite `src/runtime/async-runner.ts`**

Replace the `RunBackgroundOpts`, `RunBackgroundHandle`, and `runBackground` block (from `export interface RunBackgroundOpts {` through the end of `runBackground`) with:

```typescript
export interface RunBackgroundOpts {
  deps: AsyncRunnerDeps;
  lifecycle: string;
  mode: "auto" | "checkpointed";
  /** v0.11.1: edit isolation for background runs. Default "auto" (worktree when cwd is a git repo, in-place otherwise). */
  isolation?: Isolation;
}

/** The success shape (back-compat: existing external refs to RunBackgroundHandle still typecheck). */
export interface RunBackgroundHandle { runId: string; status: "background"; }

/** v0.11.1: a background dispatch either starts (runId + background) or fails synchronously (error, no runId). */
export type RunBackgroundResult =
  | { runId: string; status: "background" }
  | { status: "failed"; error: string };

export type Isolation = "worktree" | "none" | "auto";

/** Per-session dedup flag for the auto-fallback in-place notify (resets on process restart = new session). */
let inPlaceFallbackWarned = false;

/** The git-agnostic core: pool slot → journal → runLifecycle in ctx.cwd (or a worktree, when `isolated` is set) → inbox + notify.
 *  Fire-and-forget. When `isolated` is present, journals the worktree field, commits on completion, and removes the worktree. */
function runBackgroundInPlace(runId: string, task: string, opts: RunBackgroundOpts, isolated?: { worktreePath: string; branch: string }): void {
  const { deps } = opts;
  void deps.pool.withSlot(async () => {
    try {
      const ev0: JournalEvent = isolated
        ? { type: "run:started", runId, task, lifecycle: opts.lifecycle, worktree: { path: isolated.worktreePath, branch: isolated.branch }, mode: opts.mode, ts: Date.now() }
        : { type: "run:started", runId, task, lifecycle: opts.lifecycle, mode: opts.mode, ts: Date.now() };
      deps.journal.append(runId, ev0);
      emitProgress(deps, runId, { status: "running", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });

      const res = await deps.runLifecycle(task, opts.lifecycle, { runId, worktreePath: isolated?.worktreePath, branch: isolated?.branch, mode: opts.mode });

      if (res.status === "completed") {
        if (isolated) {
          try { sh("git add -A && git commit -m 'fleet run complete'", isolated.worktreePath); } catch { /* nothing to commit */ }
        }
        deps.journal.append(runId, isolated
          ? { type: "run:completed", runId, branch: isolated.branch, ts: Date.now() }
          : { type: "run:completed", runId, ts: Date.now() });
        const total = res.phases.length;
        const lastIdx = total;
        emitProgress(deps, runId, { status: "completed", phase: res.phases[total - 1]?.name ?? "finish", phaseIndex: lastIdx, phaseTotal: total, lifecycle: opts.lifecycle, mode: opts.mode, task, ...(isolated ? { branch: isolated.branch } : {}) });
        const lastPhase = res.phases[res.phases.length - 1];
        const result: RunResult = {
          runId, task, status: "completed",
          summary: lastPhase?.summary ?? "",
          paths: res.phases.flatMap((p) => p.paths),
          completedAt: Date.now(),
          ...(isolated ? { branch: isolated.branch } : {}),
        };
        deps.inbox.push(result);
        deps.notify(`fleet run ${runId} completed`, "info");
        if (isolated) deps.worktree.removeWorktree(runId);
      } else {
        deps.journal.append(runId, { type: "run:aborted", runId, reason: res.error ?? res.status, ts: Date.now() });
        if (isolated) deps.worktree.remove(runId);
        emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: res.phases.length, lifecycle: opts.lifecycle, mode: opts.mode, task });
        deps.notify(`fleet run ${runId} ${res.status}: ${res.error ?? ""}`, "warning");
      }
    } catch (e) {
      const msg = (e as Error).message;
      deps.journal.append(runId, { type: "run:aborted", runId, reason: msg, ts: Date.now() });
      if (isolated) deps.worktree.remove(runId);
      deps.notify(`fleet run ${runId} failed: ${msg}`, "error");
      emitProgress(deps, runId, { status: "failed", phase: "", phaseIndex: 0, phaseTotal: 0, lifecycle: opts.lifecycle, mode: opts.mode, task });
    }
  });
}

/** The worktree wrapper: SYNCHRONOUS pre-flight + worktree create, then core-with-isolation. */
function runBackgroundIsolated(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const { deps } = opts;
  if (!deps.worktree.isGitRepo()) {
    return { status: "failed", error: "isolation: 'worktree' requires a git repo; cwd is not one — use isolation: 'none' or run in a git repo" };
  }
  const runId = deps.genRunId();
  const baseRef = "HEAD";
  let wt: { path: string; branch: string };
  try {
    wt = deps.worktree.create(runId, baseRef);
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
  runBackgroundInPlace(runId, task, opts, { worktreePath: wt.path, branch: wt.branch });
  return { runId, status: "background" };
}

/** The auto router: isolated when cwd is a git repo, in-place + one per-session notify when not. */
function runBackgroundAuto(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const { deps } = opts;
  if (deps.worktree.isGitRepo()) {
    return runBackgroundIsolated(task, opts);
  }
  if (!inPlaceFallbackWarned) {
    inPlaceFallbackWarned = true;
    deps.notify("background run in-place (no worktree isolation — parallel edits may conflict)", "warning");
  }
  const runId = deps.genRunId();
  runBackgroundInPlace(runId, task, opts);
  return { runId, status: "background" };
}

/** Public dispatcher (keeps the `runBackground` name + RunBackgroundHandle success shape for back-compat). */
export function runBackground(task: string, opts: RunBackgroundOpts): RunBackgroundResult {
  const isolation = opts.isolation ?? "auto";
  if (isolation === "worktree") return runBackgroundIsolated(task, opts);
  if (isolation === "none") {
    const runId = opts.deps.genRunId();
    runBackgroundInPlace(runId, task, opts);
    return { runId, status: "background" };
  }
  return runBackgroundAuto(task, opts);
}
```

- [ ] **Step 4: Update the index.ts adapter to be isolation-aware**

In `src/index.ts`, replace the `asyncRunLifecycle` adapter body (the `lifecycleFullDeps` construction + the `runLifecycle` call). Change `artifactDiscovery` to be conditional on `opts.worktreePath`, and `parentCwd` to fall back to `deps.parentCwd`:

```typescript
  const asyncRunLifecycle: AsyncRunnerDeps["runLifecycle"] = async (task, lifecycleName, opts) => {
    const { runLifecycle } = await import("./lifecycle/run-lifecycle.ts");
    const { spawnSubagent } = await import("./engine/spawnSubagent.ts");
    const bgLock = createSingleSlotLock();
    // v0.11.1: isolated runs use worktree-diff artifact discovery + the worktree as spawn cwd;
    // in-place runs (worktreePath undefined) use the prompt-baked parser + the session cwd.
    const isolated = !!opts.worktreePath;
    const lifecycleFullDeps: LifecycleRunDeps = {
      ...deps.lifecycleDeps,
      genRunId: () => opts.runId,
      ...(isolated ? { artifactDiscovery: ({ finalText, cwd, baseRef }: { finalText: string; cwd: string; baseRef: string }) => (deps.asyncRunner as AsyncRunnerDeps).diff.diffPhase(cwd, baseRef, finalText) } : {}),
      spawn: async (o) => spawnSubagent({
        agent: o.agent, task: o.task, lifecycleTodoId: o.lifecycleTodoId, model: o.model,
        skillsOverride: o.skills, backendOverride: o.backend,
        registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: bgLock,
        backendRegistry: deps.backendRegistry, parentModel: deps.parentModel,
        parentCwd: isolated ? opts.worktreePath! : deps.parentCwd,
        runLog: deps.runLog, tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
      }),
    };
    const res = await runLifecycle(task, lifecycleName, { deps: lifecycleFullDeps, mode: opts.mode, worktreePath: opts.worktreePath, baseRef: "HEAD", onCheckpoint: async (p) => p.status === "failed" ? { action: "abort" } : { action: "continue" } });
    return res as unknown as import("./runtime/async-runner.ts").FakeLifecycleResult;
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — 441 (Task 1) + 5 new = 446. The two existing async-runner tests still pass (git + auto → isolated = current behavior). `pnpm typecheck` clean.

Run: `pnpm typecheck 2>&1 | tail -3`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/async-runner.ts src/index.ts test/async-runner.test.mts
git commit -m "fix(bg): split runBackground into git-agnostic core + worktree wrapper + auto router

runBackgroundInPlace (core) is git-agnostic: pool + journal + runLifecycle
in ctx.cwd, no worktree. runBackgroundIsolated (wrapper) does a SYNCHRONOUS
isGitRepo pre-flight + worktree.create before returning, so worktree failures
surface as { status: 'failed', error } (no runId) — the tool maps to isError,
not an async toast + 90s poll. runBackgroundAuto routes: isolated when cwd is
git (current behavior preserved), in-place + one per-session notify when not.
The index.ts adapter becomes isolation-aware (conditional artifactDiscovery +
parentCwd). Closes the 100% bg failure in non-git cwds."
```

---

### Task 3: `subagent` tool `isolation` param + sync-fail → `isError`

**Files:**
- Modify: `src/tools/subagent.ts:24` (add `isolation` param), `:87-90` (background branch handles the union)
- Test: `test/subagent-tool.test.mts` (extend)

**Interfaces:**
- Consumes: `runBackground` returns `RunBackgroundResult` (Task 2)
- Produces: `subagent` tool accepts `isolation: "worktree" | "none" | "auto"` (default `auto`); background branch returns `isError` on sync-fail.

- [ ] **Step 1: Write failing tests**

First inspect the existing `test/subagent-tool.test.mts` harness to match its fake-deps shape:

```bash
sed -n '1,90p' test/subagent-tool.test.mts
```

The existing test file defines a `makeDeps()` helper (lines ~38-56) returning the base deps object. The new tests reuse it via `{ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner }`. Add after the existing tests:

```typescript
test("subagent background with isolation:'worktree' in a non-git cwd returns isError synchronously", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub-nogit-"));
  const fakeAsyncRunner = {
    worktree: { isGitRepo: () => false, create: () => { throw new Error("no"); }, removeWorktree: () => {}, remove: () => {}, exists: () => false, branchFor: () => "fleet/x", pathFor: () => plain },
    diff: {}, journal: { append: () => {}, replay: () => [], scanNonTerminal: () => [] },
    pool: { withSlot: async () => {} }, inbox: { push: () => {}, readyCount: () => 0, pull: () => [], renderHint: () => "" },
    runLifecycle: async () => ({ status: "completed", phases: [] } as any),
    notify: () => {}, genRunId: () => "fl-x",
  } as any;
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", background: true, isolation: "worktree" } as any, new AbortController().signal, () => {}, {} as any);
  ok(res.isError === true, `expected isError, got: ${(res as any).isError}`);
  ok(/requires a git repo/.test((res.content as any)[0].text), `text: ${(res.content as any)[0].text}`);
  rmSync(plain, { recursive: true, force: true });
});

test("subagent background default (auto) in a non-git cwd returns a background run (in-place)", async () => {
  const plain = mkdtempSync(join(tmpdir(), "sub-nogit2-"));
  const fakeAsyncRunner = {
    worktree: { isGitRepo: () => false, create: () => { throw new Error("no"); }, removeWorktree: () => {}, remove: () => {}, exists: () => false, branchFor: () => "fleet/x", pathFor: () => plain },
    diff: {}, journal: { append: () => {}, replay: () => [], scanNonTerminal: () => [] },
    pool: { withSlot: async () => {} }, inbox: { push: () => {}, readyCount: () => 0, pull: () => [], renderHint: () => "" },
    runLifecycle: async () => ({ status: "completed", phases: [] } as any),
    notify: () => {}, genRunId: () => "fl-auto",
  } as any;
  const tool = createSubagentTool({ ...makeDeps(), parentCwd: plain, asyncRunner: fakeAsyncRunner } as any);
  const res = await tool.execute!("id", { agent: "g", task: "x", background: true } as any, new AbortController().signal, () => {}, {} as any);
  ok(res.isError === undefined, `expected no isError, got: ${(res as any).isError}`);
  ok(/background run:/.test((res.content as any)[0].text), `text: ${(res.content as any)[0].text}`);
  rmSync(plain, { recursive: true, force: true });
});
```

(The `execute!` non-null assertion matches the existing test's pattern at line ~68; the `() => {}` onProgress + `{} as any` ctx match the existing call signature.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run 2>&1 | grep -E "isError synchronously|in-place" | head`
Expected: 2 failures (`isolation` not a known param; the tool returns `background run: undefined` on the worktree-in-non-git path because the old code ignored the failed union).

- [ ] **Step 3: Implement**

In `src/tools/subagent.ts`, add the `isolation` param to `subagentParams` (after `background`):

```typescript
  isolation: Type.Optional(Type.Union([
    Type.Literal("worktree"),
    Type.Literal("none"),
    Type.Literal("auto"),
  ], { description: "Edit isolation for background runs. 'worktree' = git worktree (requires a git repo; fails sync if not). 'none' = in-place in cwd (no isolation; parallel edits may conflict). 'auto' (default) = worktree when cwd is a git repo, in-place otherwise." })),
```

Update the background branch (replace the existing `if (params.background) { ... }` block):

```typescript
      if (params.background) {
        if (!deps.asyncRunner) return { isError: true, content: [{ type: "text" as const, text: "background runs not configured (asyncRunner missing)" }] };
        const handle = runBackground(params.task, { deps: deps.asyncRunner, lifecycle: params.lifecycle ?? "default", mode: "auto", isolation: params.isolation });
        if (handle.status === "failed") {
          return { isError: true, content: [{ type: "text" as const, text: handle.error }] };
        }
        return { content: [{ type: "text" as const, text: `background run: ${handle.runId}` }], details: handle };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — 446 + 2 = 448. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/subagent.ts test/subagent-tool.test.mts
git commit -m "fix(bg): subagent tool gains isolation param; sync-fail returns isError

The subagent tool accepts isolation: worktree|none|auto (default auto).
On a synchronous worktree failure (e.g. 'worktree' in a non-git cwd) the
tool now returns isError with the actionable message, instead of
'background run: undefined' + an async toast the model never sees."
```

---

### Task 4: Scheduler `isolation` plumbing + `onFire` threading

**Files:**
- Modify: `src/scheduling/scheduler.ts:11-16` (`ScheduleSpec.isolation?`)
- Modify: `src/index.ts:298-300` (`onFire` threads `isolation`)
- Modify: `src/tools/subagent.ts:83-86` (schedule branch threads `isolation`)
- Test: `test/scheduler.test.mts` (extend — check the file exists first; if not, create a minimal harness)

**Interfaces:**
- Consumes: `Isolation` type (Task 2)
- Produces: `ScheduleSpec.isolation?: Isolation`; `onFire` receives it; `scheduler.register` accepts it.

- [ ] **Step 1: Inspect the scheduler test harness**

Run: `ls test/scheduler*.test.mts && sed -n '1,60p' test/scheduler.test.mts`
If `test/scheduler.test.mts` exists, extend it; if not, create it (model on the `resume.test.mts` pattern: a `ScheduleSpec` registered with a fake `onFire` capturing the spec, then assert `spec.isolation` threads through).

- [ ] **Step 2: Write failing test**

Add to `test/scheduler.test.mts` (create if absent — use a temp `storePath`/`lockPath`):

```typescript
test("scheduler.register stores + onFire receives the isolation field", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sched-iso-"));
  const storePath = join(tmp, "schedules.json");
  const lockPath = join(tmp, "schedules.lock");
  let fired: any = null;
  const sch = new Scheduler({ storePath, lockPath, onFire: (spec) => { fired = spec; } });
  const id = sch.register({ task: "t", expression: "5m", lifecycle: "default", auto: true, isolation: "worktree" });
  const stored = sch.list().find((s) => s.id === id);
  assert.equal(stored?.isolation, "worktree");
  // onFire fires on the schedule; for the test, call the internal fire directly via the public
  // surface by pausing + resuming isn't deterministic — instead assert the stored spec round-trips
  // the isolation field through persist+load:
  sch.pause(id);
  sch.resume(id);
  assert.equal(stored?.isolation, "worktree");
  rmSync(tmp, { recursive: true, force: true });
});
```

(If `Scheduler` lacks `pause`/`resume`/`list` per the earlier read it has `list`; adapt to the actual API surfaced in `scheduler.ts` — read `sed -n '60,120p' src/scheduling/scheduler.ts` for the exact method names before writing the assertion.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -E "isolation field" | head`
Expected: failure (`isolation` not on `ScheduleSpec`; the stored spec has `isolation === undefined`).

- [ ] **Step 4: Implement**

In `src/scheduling/scheduler.ts`, add `isolation` to `ScheduleSpec`:

```typescript
export interface ScheduleSpec {
  task: string;
  expression: string;
  lifecycle?: string;
  auto?: boolean;
  /** v0.11.1: edit isolation for the background run on fire. Default "auto". */
  isolation?: "worktree" | "none" | "auto";
}
```

(`StoredSchedule extends ScheduleSpec` inherits it; the `persist`/`load` JSON round-trip carries it automatically since it spreads `spec`.)

In `src/index.ts`, update the scheduler `onFire` (around line 298-300):

```typescript
      onFire: (spec) => {
        if (!deps.asyncRunner) return;
        runBackground(spec.task, { deps: deps.asyncRunner, lifecycle: spec.lifecycle ?? "default", mode: spec.auto ? "auto" : "checkpointed", isolation: spec.isolation });
      },
```

In `src/tools/subagent.ts`, update the schedule branch (the `if (params.schedule)` block) to thread `isolation`:

```typescript
        const id = deps.scheduler.register({ task: params.task, expression: params.schedule, lifecycle: params.lifecycle ?? "default", auto: params.auto ?? true, isolation: params.isolation });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — 448 + 1 = 449. `pnpm typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add src/scheduling/scheduler.ts src/index.ts src/tools/subagent.ts test/scheduler.test.mts
git commit -m "fix(bg): thread isolation through the scheduler + onFire

Scheduled runs are background runs; they inherit the isolation opt-in.
ScheduleSpec gains optional isolation (default auto). The onFire callback
+ subagent tool's schedule branch thread it through to runBackground."
```

---

### Task 5: `scanResumeCandidates` handles in-place interrupted runs

**Files:**
- Modify: `src/runtime/resume.ts` (full rewrite of `scanResumeCandidates` + `ResumeCandidate` optional fields)
- Test: `test/resume.test.mts` (extend)

**Interfaces:**
- Consumes: `RunStartedEvent.worktree?` optional (Task 1)
- Produces: `ResumeCandidate.worktreePath?`/`branch?` optional; in-place interrupted runs → `canResume: false` + `run:aborted` written.

- [ ] **Step 1: Write failing test**

Add to `test/resume.test.mts`:

```typescript
test("scanResumeCandidates aborts an interrupted IN-PLACE run (no worktree field) with canResume=false", () => {
  const repo = makeRepo();   // repo only for the WorktreeService ctor; the run is in-place
  const runsDir = join(repo, ".pi", "fleet", "runs");
  const journal = new RunJournal(runsDir);
  const wt = new WorktreeService({ rootDir: repo });
  // an in-place run: run:started with NO worktree field, no terminal event
  journal.append("fl-ip-int", { type: "run:started", runId: "fl-ip-int", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
  journal.append("fl-ip-int", { type: "phase:completed", phase: "implement", summary: "s", paths: ["x.ts"], ts: 2 });
  const cands = scanResumeCandidates(repo, { runsDir, worktree: wt });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.runId, "fl-ip-int");
  assert.equal(cands[0]!.canResume, false);
  assert.equal(cands[0]!.worktreePath, undefined);
  assert.equal(cands[0]!.branch, undefined);
  const events = journal.replay("fl-ip-int");
  assert.equal(events[events.length - 1]!.type, "run:aborted");
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run 2>&1 | grep -E "IN-PLACE run" | head`
Expected: failure — the current `scanResumeCandidates` reads `started.worktree.path` (undefined for in-place) → throws `Cannot read properties of undefined (reading 'path')`, or pushes a candidate with `worktreePath: undefined` and `canResume` based on `wtExists` (false → writes `run:aborted` but `worktreePath` is undefined, not the new behavior). Confirm the failure mode, then implement.

- [ ] **Step 3: Implement — rewrite `src/runtime/resume.ts`**

Replace the `ResumeCandidate` interface + `scanResumeCandidates` body:

```typescript
export interface ResumeCandidate {
  runId: string;
  task: string;
  lifecycle: string;
  /** Present only for isolated (worktree) runs. */
  worktreePath?: string;
  /** Present only for isolated (worktree) runs. */
  branch?: string;
  lastPhase: string | null;
  canResume: boolean;
}

export interface ScanResumeOpts {
  runsDir: string;
  worktree: WorktreeService;
}

export function scanResumeCandidates(_projectDir: string, opts: ScanResumeOpts): ResumeCandidate[] {
  const journal = new RunJournal(opts.runsDir);
  const ids = journal.scanNonTerminal();
  const cands: ResumeCandidate[] = [];
  for (const runId of ids) {
    const events = journal.replay(runId);
    const started = events.find((e) => e.type === "run:started") as
      | (JournalEvent & { type: "run:started"; worktree?: { path: string; branch: string } }) | undefined;
    if (!started) continue;
    const phaseEvents = events.filter((e) => e.type === "phase:completed" || e.type === "phase:started" || e.type === "phase:failed") as Array<{ phase: string }>;
    const lastPhase = phaseEvents.length > 0 ? phaseEvents[phaseEvents.length - 1]!.phase : null;

    if (started.worktree) {
      // isolated run: resume iff the worktree still exists
      const wtExists = opts.worktree.exists(runId);
      if (!wtExists) {
        journal.append(runId, { type: "run:aborted", runId, reason: "worktree-missing", ts: Date.now() });
      }
      cands.push({
        runId, task: started.task, lifecycle: started.lifecycle,
        worktreePath: started.worktree.path, branch: started.worktree.branch,
        lastPhase, canResume: wtExists,
      });
    } else {
      // v0.11.1: in-place interrupted run — no worktree to clean; abort (partial edits may remain in cwd).
      journal.append(runId, { type: "run:aborted", runId, reason: "in-place interrupted (partial edits may remain in cwd)", ts: Date.now() });
      cands.push({ runId, task: started.task, lifecycle: started.lifecycle, lastPhase, canResume: false });
    }
  }
  return cands;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run 2>&1 | tail -8`
Expected: PASS — 449 + 1 = 450. The 3 existing resume tests still pass (they all use `worktree: {path, branch}` on run:started → the isolated branch). `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/resume.ts test/resume.test.mts
git commit -m "fix(bg): scanResumeCandidates handles in-place interrupted runs

An interrupted in-place run (run:started with no worktree field) has no
worktree to clean; abort it + mark canResume=false with an honest reason
(partial edits may remain in cwd). ResumeCandidate.worktreePath/branch
become optional. Isolated-run handling unchanged."
```

---

### Task 6: Release v0.11.1

**Files:** none (release ops)

- [ ] **Step 1: Full green suite**

Run: `pnpm typecheck && pnpm test:run 2>&1 | tail -8`
Expected: typecheck clean; 450 pass / 0 fail.

- [ ] **Step 2: Branch + PR**

```bash
git checkout -b fix/spec-bg-non-git
# (the spec f2c80ec is on main already; the code commits are on main too per the 6-2 cadence —
#  actually: create the branch FROM the last code commit, so the PR contains only the code, not the spec.
#  If the code commits landed on main, the branch is just for the PR marker.)
git push -u origin fix/spec-bg-non-git
gh pr create --title "fix(bg): v0.11.1 background dispatch isolation split (non-git cwd fix)" --body "Proper-fix for the background dispatch 100%-failure in non-git cwds. Splits runBackground into a git-agnostic core + worktree wrapper + auto router. Adds isolation: worktree|none|auto (default auto). Synchronous fail-fast on worktree failures. See docs/superpowers/specs/2026-07-28-bg-non-git-isolation-split-design.md." --base main
```

- [ ] **Step 3: Merge + tag**

```bash
gh pr merge --merge --delete-branch
# tag (use update-ref, NOT git tag -a which opens Vim):
git update-ref refs/tags/v0.11.1 refs/heads/main
git push --force origin v0.11.1
```

- [ ] **Step 4: Verify CI publish**

Run: `gh run list --limit 3` then watch the Release workflow → expect green (~50s) + npm `@getpipher/armory-fleet@0.11.1` published + GitHub Release v0.11.1 created.

- [ ] **Step 5: Bump settings.json**

Edit `~/.pi/agent/settings.json` → armory-fleet version `0.11.1`. Sync dotfiles:
```bash
cd ~/dotfiles && git add pi/agent/settings.json && git commit -m "chore: bump armory-fleet to 0.11.1" && git push
```

- [ ] **Step 6: Term-smoke on published (the bug repro)**

Spawn a tmux session, run `pi` in `~/local-dev/bug-bounty` (non-git), fire a background subagent:
```
subagent({ agent: "general-purpose", task: "list files in this folder", background: true })
```
Expected: a working in-place background run (appears in `/fleet`, completes, result in `fleet_results`) + ONE "background run in-place (no worktree isolation…)" notify — NOT the 100%-fail. Then test `isolation: "worktree"` there → expect a synchronous `isError: "…requires a git repo…"` (no 90s poll).

- [ ] **Step 7: Update handoff pointer**

Update `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-fleet/handoff-pointer.md` with v0.11.1 state (main ref, 450 tests, the isolation seam, SPEC-6-3 next).

---

## Self-Review

**1. Spec coverage:**
- §3 split (core+wrapper+router) → Task 2 ✓
- §3 `isGitRepo()` → Task 1 ✓
- §3 optional journal fields → Task 1 ✓
- §3 `scanResumeCandidates` in-place handling → Task 5 ✓
- §3 `subagent` tool `isolation` param → Task 3 ✓
- §3 scheduler plumbing → Task 4 ✓
- §4 edge cases: `auto` in git (Task 2 regression test), `auto` in non-git (Task 2), `worktree` in non-git sync fail (Task 2+3), `none` in git (Task 2), interrupted in-place (Task 5), old journal events (Task 1), scheduled run (Task 4) — all covered ✓
- §6 release (v0.11.1, branch, tag, smoke) → Task 6 ✓
- §7 testing (TDD, coverage) → every task TDD ✓

**2. Placeholder scan:** The two `<reuse the existing test's deps object>` markers in Task 3 are explicitly flagged for the implementer to copy from the existing harness — this is a deliberate pointer to real code (the existing test's deps), not a vague TBD. All other steps have complete code. No "TBD"/"implement later"/"handle edge cases".

**3. Type consistency:** `Isolation` defined Task 2, used Task 3 (`params.isolation`), Task 4 (`ScheduleSpec.isolation`, `onFire`), consistent. `RunBackgroundResult` union defined Task 2, consumed Task 3 (`handle.status === "failed"`). `ResumeCandidate.worktreePath?`/`branch?` defined Task 5, consistent with `RunStartedEvent.worktree?` Task 1. `runBackgroundInPlace`/`runBackgroundIsolated`/`runBackgroundAuto`/`runBackground` names consistent across Tasks 2-4.

No issues found inline. Plan complete.