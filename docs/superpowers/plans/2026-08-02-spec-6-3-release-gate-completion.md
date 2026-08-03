# SPEC-6-3 Release-Gate Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the missing SPEC-6-3 runtime integration so workflows-as-code is genuinely usable through the model tool and `/fleet` Workflows view before releasing `@getpipher/armory-fleet@0.12.0`.

**Architecture:** A session-scoped `WorkflowController` owns definitions, live/history state, controls, persistence, recovery, and runner adapters. A reactive `WorkflowRunStore` feeds both the panel and model tool; the runner exposes explicit progress/pause/abort hooks and one tracked spawn wrapper for concurrency, accounting, retries, and overrides. `index.ts` constructs these components but contains no workflow behavior.

**Tech Stack:** TypeScript (raw `.ts` via tsx), Node.js `vm`/`node:test`, `@earendil-works/pi-coding-agent` extension API, `@earendil-works/pi-tui`, TypeBox, existing `ConcurrencyPool`, `ResultsInbox`, `WorkflowJournal`, lifecycle runner, and subagent engine.

## Global Constraints

- Work only in `/Users/rector/local-dev/getpipher/armory-fleet`; do not inspect or modify sibling repositories.
- Branch: `feat/spec-6-3-workflows`; PR: `#21`; package version remains `0.12.0`.
- Tests belong only in `test/*.test.mts`, importing from `../src/...`; `pnpm test:run` must include every new test.
- Use TDD for every task: focused RED → minimal GREEN → focused test → `pnpm typecheck` → full `pnpm test:run --test-timeout=30000` → commit.
- 2-space indent; EOF newline; no TODO/FIXME/HACK; no silent errors; no AI attribution.
- Preserve existing subagent/lifecycle/scheduler/Tiers/Fleet/Runs behavior.
- `vm` is a determinism boundary, not a hostile-code security boundary.
- Project workflow precedence remains project > global > builtin.
- Background workflow dispatch defaults to `true`; foreground is explicit.
- Pause is cooperative; Stop aborts active children and journals exactly one terminal abort.
- Workflow concurrency is clamped to 16 and must not use the extension's foreground singleton lock.
- Cost/token totals come from tracked child results, never TODO correlation.
- No merge, tag, npm publication, or Pi settings bump until Task 14 passes all seven local real-Pi smokes and the final review has no Critical/Important findings.
- Each task receives a fresh implementer and a fresh reviewer. A task is complete only after its reviewer reports 0 Critical/Important findings.

## File Responsibility Map

| File | Responsibility |
|---|---|
| `src/workflows/source.ts` | Parse metadata, retain editable source/body, normalize executable CommonJS async wrapper, validate save names. |
| `src/workflows/registry.ts` | Discover precedence-scoped definitions using `parseWorkflowSource`; refreshable registry. |
| `src/workflows/runtime/types.ts` | Public controller/store/progress/start/save/control types. |
| `src/workflows/runtime/run-store.ts` | Reactive workflow run state map. |
| `src/workflows/runtime/pause-gate.ts` | Cooperative pause/resume/stop waiting primitive. |
| `src/workflows/runtime/adapters.ts` | Production child/lifecycle adapters, workflow pool, override/timeout/cancellation forwarding. |
| `src/workflows/runtime/save.ts` | Atomic validated project-scope save. |
| `src/workflows/runtime/hydrate.ts` | Reconstruct terminal/interrupted/checkpoint state from journals. |
| `src/workflows/runtime/controller.ts` | Single owner of starts, background completion, controls, checkpoint resolvers, save, refresh, and hydration. |
| `test/helpers/deferred.mts` | Typed deferred Promise helper used by deterministic async tests. |
| `test/helpers/workflow-runner-fixture.mts` | Shared runner deps/child/cleanup fixture for Tasks 3–4. |
| `test/helpers/workflow-controller-fixture.mts` | Shared fake registry/journal/store/runner/controller fixture for Tasks 6–9 and 12–13. |
| `test/helpers/workflow-panel-fixture.mts` | Shared fake UI/theme/controller panel fixture for Tasks 11–12. |
| `src/workflows/journal.ts` | Append/replay additive `wf:progress` snapshots. |
| `src/workflows/runner.ts` | Deterministic execution, runtime hooks, tracked spawning, retry/defaults, accounting, cancellation. |
| `src/tools/fleet.ts` | Thin TypeBox/model adapter over `WorkflowController`; no runtime stubs. |
| `src/workflows/keyword.ts` | Bounded keyword authorization helper. |
| `src/workflows/panel/workflows-items.ts` | Pure combined definition/run row and action model. |
| `src/panel/fleet-panel.ts` | Interactive Workflows actions and existing Runs viewer bridge. |
| `src/workflows/panel-host.ts` | Close/reopen custom panel around `ctx.ui.editor`/confirm and model prompt handoff. |
| `src/index.ts` | Per-session construction/wiring/disposal only. |

---

### Task 1: Canonical workflow source parser + executable builtins

**Files:**
- Create: `src/workflows/source.ts`
- Modify: `src/workflows/registry.ts`
- Modify: `src/workflows/vm-realm.ts`
- Test: `test/workflow-source.test.mts`
- Extend: `test/workflow-registry.test.mts`

**Interfaces:**
- Produces:
  - `WorkflowMeta`
  - `ParsedWorkflowSource`
  - `validateWorkflowName(name: string): void`
  - `parseWorkflowSource(source: string, opts: { filePath: string; requireMeta: boolean }): ParsedWorkflowSource`
  - `WorkflowDef.sourceText`, `.body`, `.executable`
- Consumed by Tasks 6, 8, 10, and 13.

- [ ] **Step 1: Write failing parser/normalizer tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRealm, compileWorkflowScript } from "../src/workflows/vm-realm.ts";
import { parseWorkflowSource, validateWorkflowName } from "../src/workflows/source.ts";

const SOURCE = `export const meta = {
  name: 'review',
  description: 'review code',
  phases: [{ title: 'Scan' }],
}
phase('Scan')
const value = await agent('inspect')
return value
`;

test("parseWorkflowSource retains source and produces an executable async body", async () => {
  const parsed = parseWorkflowSource(SOURCE, { filePath: "/review.js", requireMeta: true });
  assert.equal(parsed.meta?.name, "review");
  assert.match(parsed.body, /await agent/);
  assert.doesNotMatch(parsed.body, /export const meta/);
  const realm = buildRealm({
    agent: async () => "ok", parallel: async () => [], pipeline: async (v) => v,
    phase: () => {}, workflow: async () => null, verify: async () => null,
    judgePanel: async () => null, loopUntilDry: async () => [], completenessCheck: async () => null,
    gate: async () => null, retry: async () => null, checkpoint: async () => true,
    log: () => {}, args: undefined, cwd: "/tmp",
    budget: { total: Infinity, spent: () => 0, remaining: () => Infinity },
  });
  assert.equal(await compileWorkflowScript(parsed.executable).runInContext(realm), "ok");
});

test("all shipped builtins parse and compile", () => {
  for (const name of ["code-review", "deep-research", "adversarial-review", "multi-perspective", "codebase-audit"]) {
    const filePath = join(process.cwd(), "src", "workflows", "builtin", `${name}.js`);
    const parsed = parseWorkflowSource(readFileSync(filePath, "utf8"), { filePath, requireMeta: true });
    assert.equal(parsed.meta?.name, name);
    assert.doesNotThrow(() => compileWorkflowScript(parsed.executable));
  }
});

test("legacy CommonJS is preserved and malformed metadata is actionable", () => {
  const legacy = "module.exports = (async () => 7)()";
  assert.equal(parseWorkflowSource(legacy, { filePath: "inline", requireMeta: false }).executable, legacy);
  assert.throws(
    () => parseWorkflowSource("export const meta = { name: 'x' }\nreturn 1", { filePath: "/x.js", requireMeta: true }),
    /\/x\.js: meta\.description missing/,
  );
});

test("workflow names reject traversal and accept kebab-case", () => {
  assert.doesNotThrow(() => validateWorkflowName("auth-audit"));
  for (const bad of ["", "../x", "A", "a_b", "con", "x/y"]) {
    assert.throws(() => validateWorkflowName(bad), /invalid workflow name/);
  }
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test test/workflow-source.test.mts test/workflow-registry.test.mts
```

Expected: FAIL because `src/workflows/source.ts` and normalized registry fields do not exist; the raw builtins are not compilable.

- [ ] **Step 3: Implement the parser and normalized registry fields**

Create these exact public shapes:

```ts
export interface WorkflowMeta {
  name: string;
  description: string;
  phases: { title: string }[];
}

export interface ParsedWorkflowSource {
  meta?: WorkflowMeta;
  source: string;
  body: string;
  executable: string;
}
```

Implement a balanced-brace scanner beginning at the object literal after `export const meta =`. It must ignore braces inside quoted strings, remove only the complete declaration span, evaluate only the extracted object under the existing trusted-dev posture, and return:

```ts
const executable = /^\s*module\.exports\s*=/.test(body)
  ? body
  : `module.exports = (async () => {\n${body}\n})()`;
```

`validateWorkflowName` accepts `/^[a-z][a-z0-9-]{0,63}$/` and rejects case-insensitive Windows device names `con`, `prn`, `aux`, `nul`, `com1`–`com9`, and `lpt1`–`lpt9`.

Change `WorkflowDef` to:

```ts
export interface WorkflowDef {
  name: string;
  description: string;
  phases: { title: string }[];
  sourceText: string;
  body: string;
  executable: string;
  source: WorkflowSource;
  filePath: string;
}
```

`discoverWorkflows` calls `parseWorkflowSource(content, { filePath, requireMeta: true })`. Update existing registry test fixtures from `export const run = async ...` to canonical top-level body statements ending in `return`; a second ESM export in the body is invalid by design. Keep `compileWorkflowScript` as the final `vm.Script` constructor; it now receives normalized executable text.

- [ ] **Step 4: Verify GREEN and compatibility**

Run:

```bash
node --import tsx --test test/workflow-source.test.mts test/workflow-registry.test.mts test/workflow-vm-realm.test.mts test/workflow-runner.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

Expected: focused tests pass; full suite has no failures.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/source.ts src/workflows/registry.ts src/workflows/vm-realm.ts test/workflow-source.test.mts test/workflow-registry.test.mts
git commit -m "fix(spec-6-3): normalize saved and builtin workflow source"
```

---

### Task 2: Runtime state types, reactive store, and pause gate

**Files:**
- Create: `src/workflows/runtime/types.ts`
- Create: `src/workflows/runtime/run-store.ts`
- Create: `src/workflows/runtime/pause-gate.ts`
- Create: `test/helpers/deferred.mts`
- Test: `test/workflow-runtime-store.test.mts`
- Test: `test/workflow-pause-gate.test.mts`

**Interfaces:**
- Produces `WorkflowStatus`, `WorkflowRunState`, `WorkflowProgressEvent`, `WorkflowStartInput`, `WorkflowStartReceipt`, `WorkflowSaveInput`, `WorkflowRunStore`, `PauseGate`.
- Consumed by all later tasks.

- [ ] **Step 1: Write failing store and pause tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRunStore } from "../src/workflows/runtime/run-store.ts";
import { PauseGate } from "../src/workflows/runtime/pause-gate.ts";
import type { WorkflowRunState } from "../src/workflows/runtime/types.ts";

function row(status: WorkflowRunState["status"] = "queued"): WorkflowRunState {
  return {
    runId: "wf-1", name: "demo", script: "return 1", mode: "auto", status, startedAt: 1,
    currentPhase: "default", phases: [], childRunIds: [], logs: [], tokenTotal: 0, costTotal: 0,
  };
}

test("WorkflowRunStore emits once per set and unsubscribe stops delivery", () => {
  const store = new WorkflowRunStore();
  const seen: string[] = [];
  const off = store.subscribe((runId) => seen.push(runId));
  store.set("wf-1", row());
  off();
  store.set("wf-1", row("running"));
  assert.deepEqual(seen, ["wf-1"]);
  assert.equal(store.get("wf-1")?.status, "running");
  assert.equal([...store.values()].length, 1);
});

test("PauseGate blocks new work, resumes all waiters, and stop rejects them", async () => {
  const gate = new PauseGate();
  gate.pause();
  let released = false;
  const waiting = gate.wait(new AbortController().signal).then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  gate.resume();
  await waiting;
  assert.equal(released, true);

  gate.pause();
  const aborter = new AbortController();
  const stopped = gate.wait(aborter.signal);
  aborter.abort(new Error("workflow stopped"));
  await assert.rejects(stopped, /workflow stopped/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test test/workflow-runtime-store.test.mts test/workflow-pause-gate.test.mts
```

Expected: FAIL with missing runtime modules.

- [ ] **Step 3: Implement exact state contracts and primitives**

Define the state fields from the approved amendment, plus:

```ts
export interface WorkflowStartInput {
  script?: string;
  workflowName?: string;
  name?: string;
  overwrite?: boolean;
  args?: unknown;
  mode: "auto" | "checkpointed";
  background?: boolean;
  resumeFromRunId?: string;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
}

export interface WorkflowStartReceipt {
  runId: string;
  status: "background";
}

export interface WorkflowSaveInput {
  name: string;
  source: string;
  overwrite?: boolean;
}
```

`WorkflowRunState` includes required `mode: "auto" | "checkpointed"`; progress/hydration must preserve it.

Implement `WorkflowRunStore` with a private `Map` and `Set` exactly like `BgRunsStore`, returning newest-first copies from `values()` by `startedAt`.

Implement `PauseGate` with `pause()`, `resume()`, `isPaused()`, and `wait(signal)`. `wait` resolves immediately when unpaused, registers one abort listener with `{ once: true }`, removes it on Resume, and rejects with `signal.reason` on abort.

Create this exact test helper:

```ts
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

- [ ] **Step 4: Verify GREEN and full suite**

```bash
node --import tsx --test test/workflow-runtime-store.test.mts test/workflow-pause-gate.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/runtime/types.ts src/workflows/runtime/run-store.ts src/workflows/runtime/pause-gate.ts test/helpers/deferred.mts test/workflow-runtime-store.test.mts test/workflow-pause-gate.test.mts
git commit -m "feat(spec-6-3): add workflow runtime state and pause gate"
```

---

### Task 3: Runner progress, cooperative pause, cancellation, and journal snapshots

**Files:**
- Modify: `src/workflows/journal.ts`
- Modify: `src/workflows/runner.ts`
- Create: `test/helpers/workflow-runner-fixture.mts`
- Test: `test/workflow-runner-control.test.mts`
- Extend: `test/workflow-journal.test.mts`

**Interfaces:**
- Consumes Task 2 runtime types.
- Produces `WorkflowRuntimeHooks` on `WorkflowRunDeps`; additive `wf:progress` journal events; `WorkflowRunOpts.sourceText` for editable journal/resume state.

- [ ] **Step 1: Write failing control/progress tests**

Create `test/helpers/workflow-runner-fixture.mts` by moving the exact `deps(overrides)` and `cleanup(d)` fixture from `test/workflow-runner.test.mts`; export those plus `child(finalText, runId = "fl-child")`, which returns a completed `WorkflowRunDeps.spawn` result with `tokenTotal:10` and `costTotal:0.1`. Import those helpers below. Create a fake dependency set where `runtime.waitIfPaused` records calls and `runtime.signal` can abort. Assert:

```ts
test("runner waits before each dispatch and emits phase/terminal progress", async () => {
  const events: WorkflowProgressEvent[] = [];
  let waits = 0;
  const d = deps({
    runtime: {
      signal: new AbortController().signal,
      waitIfPaused: async () => { waits++; },
      onProgress: (e) => events.push(e),
    },
  });
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => { phase('Scan'); await agent('a'); await agent('b'); return 1 })()",
    mode: "auto",
  }, d);
  assert.equal(result.status, "completed");
  assert.equal(waits, 2);
  assert.ok(events.some((e) => e.kind === "phase" && e.snapshot.currentPhase === "Scan"));
  assert.equal(events.at(-1)?.kind, "completed");
});

test("log emits a bounded visible progress snapshot", async () => {
  const events: WorkflowProgressEvent[] = [];
  const d = deps({ runtime: { signal: new AbortController().signal, waitIfPaused: async () => {}, onProgress: (e) => events.push(e) } });
  const result = await runWorkflow("x", { script: "module.exports = (async () => { log('scanning routes'); return 1 })()", mode: "auto" }, d);
  assert.deepEqual(result.logs, ["scanning routes"]);
  assert.ok(events.some((e) => e.kind === "log" && e.snapshot.logs.at(-1) === "scanning routes"));
});

test("runner abort wins over a late child completion", async () => {
  const aborter = new AbortController();
  const d = deps({
    spawn: async () => { aborter.abort(new Error("workflow stopped")); return child("late"); },
    runtime: { signal: aborter.signal, waitIfPaused: async () => {}, onProgress: () => {} },
  });
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => await agent('a'))()", mode: "auto",
  }, d);
  assert.equal(result.status, "aborted");
  assert.match(result.error ?? "", /workflow stopped/);
  const terminal = d.journal.replay(result.runId).filter((e) => e.type === "wf:aborted" || e.type === "wf:completed");
  assert.deepEqual(terminal.map((e) => e.type), ["wf:aborted"]);
});
```

Also extend journal round-trip coverage with one complete `wf:progress` event.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-runner-control.test.mts test/workflow-journal.test.mts
```

Expected: FAIL because runtime hooks and `wf:progress` are absent.

- [ ] **Step 3: Implement runtime boundaries**

Add:

```ts
export interface WorkflowRuntimeHooks {
  signal: AbortSignal;
  waitIfPaused(): Promise<void>;
  onProgress(event: WorkflowProgressEvent): void;
}
```

`WorkflowProgressEvent` uses the exact Task 2 shape `{ kind, runId, snapshot }`. Add `sourceText?: string` to `WorkflowRunOpts`; `wf:started.script` stores `opts.sourceText ?? opts.script`, and `wf:started` also stores `mode`. Change `resolveWorkflow` to return `{ sourceText: string; executable: string } | undefined`; child `workflow(name)` executes `.executable` and journals `.sourceText`.

Before each agent spawn, helper invocation, checkpoint prompt, and child workflow call:

```ts
const beforeDispatch = async (): Promise<void> => {
  await deps.runtime?.waitIfPaused();
  if (deps.runtime?.signal.aborted) {
    throw deps.runtime.signal.reason instanceof Error
      ? deps.runtime.signal.reason
      : new Error("workflow stopped");
  }
};
```

Emit state snapshots through one `emitProgress` helper that both calls `runtime.onProgress` and appends `wf:progress`. `log(message)` converts strings directly and other values with safe bounded serialization, caps each line at 500 characters and the retained list at the latest 100 entries, then emits `kind:"log"`; expose the logs on `WorkflowRunResult`. Guard terminal emission with `let terminalWritten = false`; Stop/abort writes `wf:aborted` once and can never fall through to completion.

- [ ] **Step 4: Verify GREEN and regression suite**

```bash
node --import tsx --test test/workflow-runner-control.test.mts test/workflow-journal.test.mts test/workflow-runner.test.mts test/workflow-runner-resume.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/journal.ts src/workflows/runner.ts test/helpers/workflow-runner-fixture.mts test/workflow-runner-control.test.mts test/workflow-journal.test.mts
git commit -m "feat(spec-6-3): add workflow progress pause and abort hooks"
```

---

### Task 4: Tracked spawning, retry defaults, helper overrides, and accounting

**Files:**
- Modify: `src/workflows/helpers/types.ts`
- Modify: `src/workflows/helpers/verify.ts`
- Modify: `src/workflows/helpers/judge-panel.ts`
- Modify: `src/workflows/helpers/completeness-check.ts`
- Modify: `src/workflows/runner.ts`
- Modify: `src/workflows/builtin/deep-research.js`
- Modify: `src/workflows/builtin/codebase-audit.js`
- Modify: `test/helpers/workflow-runner-fixture.mts`
- Test: `test/workflow-runner-accounting.test.mts`
- Extend: `test/workflow-runner-schema.test.mts`

**Interfaces:**
- Produces one internal `trackedSpawn` used by direct agents, helpers, and lifecycle accounting.
- `HelperSpawnResult` gains `tokenTotal?: number`.

- [ ] **Step 1: Write failing accounting/retry/forwarding tests**

```ts
test("direct and helper children share accounting and option forwarding", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const d = deps({ spawn: async (_prompt, opts) => {
    calls.push(opts);
    n++;
    return { finalText: n === 1 ? "direct" : '{"real":true,"reason":"ok"}', runId: `fl-${n}`, status: "completed", tokenTotal: 10, costTotal: 0.25 };
  }});
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => { await agent('a', { tier:'high', skills:['s'], backend:'claude' }); await verify('x', { reviewers:1, tier:'low', model:'p/m' }); return 1 })()",
    mode: "auto",
  }, d);
  assert.equal(result.tokenTotal, 20);
  assert.equal(result.costTotal, 0.5);
  assert.deepEqual(result.childRunIds, ["fl-1", "fl-2"]);
  assert.equal(calls[0]?.tier, "high");
  assert.deepEqual(calls[0]?.skills, ["s"]);
  assert.equal(calls[0]?.backend, "claude");
  assert.equal(calls[1]?.tier, "low");
  assert.equal(calls[1]?.model, "p/m");
});

test("non-schema agent preserves a valid-JSON-looking string", async () => {
  const d = deps({ spawn: async () => ({ finalText: '"quoted"', runId: "fl-1", status: "completed", tokenTotal: 1, costTotal: 0 }) });
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => await agent('a'))()", mode: "auto",
  }, d);
  assert.equal(result.result, '"quoted"');
});

test("nested workflows merge child accounting once", async () => {
  const d = deps({ resolveWorkflow: () => ({ sourceText: "return await agent('child')", executable: "module.exports = (async () => await agent('child'))()" }) });
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => await workflow('child'))()", mode: "auto", budget: { total: 20 },
  }, d);
  assert.equal(result.tokenTotal, 10);
  assert.equal(result.costTotal, 0.1);
  assert.equal(result.childRunIds.length, 1);
});

test("run-level retries apply to recoverable failures but not isolation fail-fast", async () => {
  let attempts = 0;
  const d = deps({ spawn: async () => {
    attempts++;
    return attempts === 1
      ? { finalText: "", runId: "fl-1", status: "failed" }
      : { finalText: "ok", runId: "fl-2", status: "completed" };
  }});
  const result = await runWorkflow("x", {
    script: "module.exports = (async () => await agent('a'))()", mode: "auto", agentRetries: 1,
  }, d);
  assert.equal(result.result, "ok");
  assert.equal(attempts, 2);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-runner-accounting.test.mts test/workflow-runner-schema.test.mts
```

Expected: FAIL because totals use TODO correlation, helper options/tokens are dropped, and run defaults are ignored.

- [ ] **Step 3: Implement one tracked spawn path**

Add `childRunIds` to `WorkflowRunResult`. Inside `runWorkflow`, maintain `spentTokens`, `spentCost`, and `childRunIds`. Define:

```ts
const trackedSpawn = async (prompt: string, spawnOpts: WorkflowSpawnOpts) => {
  await beforeDispatch();
  if (spentTokens >= budgetTotal) throw new Error("token budget exceeded");
  const result = await deps.spawn(prompt, spawnOpts);
  childRunIds.push(result.runId);
  spentTokens += result.tokenTotal ?? 0;
  spentCost += result.costTotal ?? 0;
  emitProgress({ kind: result.status === "completed" ? "child-completed" : "child-failed" });
  return result;
};
```

Use `trackedSpawn` everywhere. Remove TODO-ID filtering from terminal accounting. Effective retries are `(callOpts.retries as number | undefined) ?? opts.agentRetries ?? 0`; effective timeout is `(callOpts.timeoutMs as number | undefined) ?? opts.agentTimeoutMs`. Forward the timeout, skills, and backend in `WorkflowSpawnOpts`; retry failed spawns and schema mismatches, but retain the existing deterministic worktree fail-fast branch and stop retrying immediately when the workflow signal aborts.

When `workflow(name)` returns, merge the child workflow's `childRunIds`, `tokenTotal`, and `costTotal` into the parent exactly once; pass only the parent's remaining token budget into the child so recursion shares one cap. Extend helper option types to include `skills`, `backend`, `retries`, and `timeoutMs`; helper implementations forward declared `agent`/`tier`/`model` options to `ctx.spawn`. Parse JSON only when `schema` is present; preserve the non-schema string contract. `validateResult` treats `schema.type === "array"` with `Array.isArray` and `schema.type === "null"` with `value === null` before ordinary `typeof` checks.

Update the discovery calls in `deep-research.js` and `codebase-audit.js` to request JSON arrays with `{ schema: { type: "array" }, retries: 1 }`; prompts explicitly require JSON arrays of strings. This makes `loopUntilDry` receive its declared `unknown[]` rather than silently treating child strings as empty rounds.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-runner-accounting.test.mts test/workflow-runner-schema.test.mts test/workflow-helper-verify.test.mts test/workflow-helper-judge-panel.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/helpers src/workflows/runner.ts src/workflows/builtin/deep-research.js src/workflows/builtin/codebase-audit.js test/helpers/workflow-runner-fixture.mts test/workflow-runner-accounting.test.mts test/workflow-runner-schema.test.mts
git commit -m "fix(spec-6-3): track workflow children retries and accounting"
```

---

### Task 5: Production spawn/lifecycle adapters and workflow concurrency

**Files:**
- Create: `src/workflows/runtime/adapters.ts`
- Modify: `src/engine/spawnSubagent.ts`
- Test: `test/workflow-runtime-adapters.test.mts`
- Extend: `test/spawn-subagent-tier.test.mts` (or the existing spawnSubagent tier test file containing tier cases)

**Interfaces:**
- Produces `createWorkflowAdapters(base: WorkflowAdapterBase): Pick<WorkflowRunDeps, "spawn" | "runLifecycle">`.
- Adds `tierOverride?: string` to `SpawnOptions`.
- Consumed by Task 13.

- [ ] **Step 1: Write failing adapter tests**

At the top of `test/workflow-runtime-adapters.test.mts`, define `baseLock = new SingleSlotLock()`, `spawnResult(finalText)` returning a complete successful `SpawnResult`, and `base(overrides)` returning every required `WorkflowAdapterBase` field with deterministic registries, lifecycle deps, model, cwd, and injected functions. Inject fake `spawnSubagentFn` and `runLifecycleFn` into `createWorkflowAdapters`. Assert:

```ts
test("spawn adapter forwards overrides signal timeout and bypasses the foreground singleton", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const adapters = createWorkflowAdapters(base({
    spawnSubagentFn: async (opts) => { seen.push(opts as unknown as Record<string, unknown>); return spawnResult("ok"); },
  }), { concurrency: 2, signal: new AbortController().signal });
  await adapters.spawn("task", {
    agent: "general-purpose", runId: "wf-1", tier: "high", skills: ["review"], backend: "claude", timeoutMs: 500,
  });
  assert.equal(seen[0]?.tierOverride, "high");
  assert.deepEqual(seen[0]?.skillsOverride, ["review"]);
  assert.equal(seen[0]?.backendOverride, "claude");
  assert.notEqual(seen[0]?.lock, baseLock);
  assert.ok(seen[0]?.signal instanceof AbortSignal);
});

test("workflow pool permits two children and queues the third", async () => {
  let active = 0; let max = 0; const releases: Array<() => void> = [];
  const adapters = createWorkflowAdapters(base({ spawnSubagentFn: async () => {
    active++; max = Math.max(max, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return spawnResult("ok");
  }}), { concurrency: 2, signal: new AbortController().signal });
  const runs = [1, 2, 3].map((n) => adapters.spawn(String(n), { agent: "general-purpose", runId: `wf-${n}` }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(max, 2);
  releases.shift()?.(); releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();
  await Promise.all(runs);
});
```

Add lifecycle assertions: the adapter supplies phase skills/backend; maps terminal phase summary to `finalText`; returns accumulated child cost/tokens; forwards `worktreePath`; and maps checkpointed lifecycle decisions through the provided checkpoint bridge.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-runtime-adapters.test.mts
```

- [ ] **Step 3: Implement adapters**

Use one `ConcurrencyPool(Math.min(Math.max(concurrency, 1), 16))` per workflow. Every admitted child receives `new SingleSlotLock()`. Combine run and timeout signals with `AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)])` when a timeout exists.

In `spawnSubagent`, resolve against an effective agent:

```ts
const effectiveAgent = opts.tierOverride
  ? { ...agentDef, tier: opts.tierOverride }
  : agentDef;
const resolved = resolveAgentModel(effectiveAgent, opts.model, opts.parentModel, tierRegistry, modelRegistry);
```

Lifecycle adapter phase spawns use the same workflow pool and child-local lock. Capture token/cost deltas from each `SpawnResult`; map:

```ts
return {
  status: result.status,
  finalText: result.phases.at(-1)?.summary ?? result.error ?? "",
  costTotal,
  tokenTotal,
  error: result.error,
};
```

- [ ] **Step 4: Verify GREEN and existing spawn behavior**

```bash
node --import tsx --test test/workflow-runtime-adapters.test.mts test/spawn-subagent*.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/runtime/adapters.ts src/engine/spawnSubagent.ts test/workflow-runtime-adapters.test.mts test/spawn-subagent*.test.mts
git commit -m "feat(spec-6-3): wire workflow child and lifecycle adapters"
```

---

### Task 6: Controller start, foreground/background execution, and ResultsInbox delivery

**Files:**
- Create: `src/workflows/runtime/controller.ts`
- Create: `src/workflows/runtime/save.ts`
- Modify: `src/workflows/registry.ts`
- Create: `test/helpers/workflow-controller-fixture.mts`
- Test: `test/workflow-controller-start.test.mts`
- Test: `test/workflow-save.test.mts`

**Interfaces:**
- Consumes Tasks 1–5.
- Produces `WorkflowController`, `WorkflowControllerDeps`, `definitions()`, `runs()`, `getRun()`, `start()`, `editAndResume()`, `save()`, and `saveWorkflowAtomic`.

- [ ] **Step 1: Write failing controller start and save tests**

Put the first four tests below in `test/workflow-controller-start.test.mts` and the final two atomic-save tests in `test/workflow-save.test.mts`.

```ts
test("background is default, returns immediately, then updates store and inbox", async () => {
  const deferredRun = deferred<WorkflowRunResult>();
  const { controller, store, inbox } = controllerFixture({ runWorkflow: async () => deferredRun.promise });
  const receipt = await controller.start({ workflowName: "demo", mode: "auto" });
  assert.deepEqual(receipt, { runId: "wf-1", status: "background" });
  assert.equal(store.get("wf-1")?.status, "running");
  deferredRun.resolve({ runId: "wf-1", status: "completed", result: { ok: true }, phases: [], childRunIds: [], logs: [], tokenTotal: 4, costTotal: 0.2 });
  await controller.settled("wf-1");
  assert.equal(store.get("wf-1")?.status, "completed");
  assert.equal(inbox.readyCount(), 1);
});

test("foreground awaits and script/name validation leaves no ghost row", async () => {
  const { controller, store } = controllerFixture();
  const result = await controller.start({ script: "return 1", mode: "auto", background: false });
  assert.equal(result.status, "completed");
  await assert.rejects(() => controller.start({ script: "return 1", workflowName: "demo", mode: "auto" }), /exactly one/);
  assert.equal([...store.values()].length, 1);
});

test("script plus name saves before dispatch and refreshes project shadow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-save-"));
  const { controller, registry, cleanup } = controllerFixture({ projectDir: dir });
  try {
    await controller.start({ script: PROJECT_SOURCE, name: "code-review", mode: "auto", background: false });
    assert.equal(registry.get("code-review")?.source, "project");
    await assert.rejects(
      () => controller.start({ script: PROJECT_SOURCE, name: "code-review", mode: "auto", background: false }),
      /overwrite:true/,
    );
  } finally { cleanup(); }
});

test("definition-by-name executes normalized executable and unknown names are actionable", async () => {
  const seen: string[] = [];
  const { controller } = controllerFixture({ runWorkflow: async (_unused, opts) => { seen.push(opts.script); return completed(opts.runId!); } });
  await controller.start({ workflowName: "demo", mode: "auto", background: false });
  assert.match(seen[0]!, /^module\.exports = \(async/);
  await assert.rejects(() => controller.start({ workflowName: "missing", mode: "auto" }), /missing.*available: demo/);
});

test("save is atomic, refuses overwrite, and removes temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-save-"));
  const { controller, registry, cleanup } = controllerFixture({ projectDir: dir });
  try {
    const saved = controller.save({ name: "code-review", source: PROJECT_SOURCE });
    assert.equal(saved.source, "project");
    assert.equal(registry.get("code-review")?.source, "project");
    assert.throws(() => controller.save({ name: "code-review", source: PROJECT_SOURCE }), /overwrite:true/);
    assert.doesNotThrow(() => controller.save({ name: "code-review", source: UPDATED_SOURCE, overwrite: true }));
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
  } finally { cleanup(); }
});

test("rename failure preserves the prior target and removes only the temporary file", () => {
  const { saveFixture, targetPath, cleanup } = atomicSaveFixture({ renameError: new Error("disk full") });
  try {
    writeFileSync(targetPath, UPDATED_SOURCE, "utf8");
    assert.throws(() => saveFixture({ name: "code-review", source: PROJECT_SOURCE, overwrite: true }), /disk full/);
    assert.equal(readFileSync(targetPath, "utf8"), UPDATED_SOURCE);
    assert.deepEqual(readdirSync(dirname(targetPath)).filter((f) => f.includes(".tmp-")), []);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-controller-start.test.mts test/workflow-save.test.mts
```

- [ ] **Step 3: Implement controller start path**

`WorkflowControllerDeps` injects registry getter/refresh, project workflow directory, store, journal, `runWorkflow`, run-deps factory, `ResultsInbox`, `genRunId`, and notify. Add `WorkflowRegistry.replace(workflows)` that clears/repopulates the existing map so all consumers retain a live registry reference. Implement `saveWorkflowAtomic(input, fsOps = NODE_SAVE_FS)` with an injectable `SaveFs` port for deterministic failure tests: validate name + metadata equality, write/sync/close a sibling temp file, atomically rename, clean only the temp on failure, require `overwrite:true` for collisions, and refresh the registry immediately. Export `atomicSaveFixture` from the controller test helper. `start({ script, name })` saves successfully before creating a run row; save failure leaves no ghost row. `start(input, { signal }?)` combines the request signal with the run controller only for foreground execution; background dispatch detaches after returning its receipt. Track active promises in a private map and expose `settled(runId)` for tests/shutdown. Create `test/helpers/workflow-controller-fixture.mts` exporting `controllerFixture`, `completed`, `child`, `fakeController`, `execute`, event builders `started`/`progress`/`completedEvent`, async `waitFor(predicate)` with a bounded 1-second condition poll, and canonical constants `SOURCE`, `ONE_AGENT`, `TWO_AGENTS`, `CHECKPOINT_SCRIPT`, `ORIGINAL_SOURCE`, `EDITED_SOURCE`, `PROJECT_SOURCE`, and `UPDATED_SOURCE`; every helper returns the real Task 2/Task 4 types and owns temp-dir cleanup through a returned `cleanup()` callback.

Resolve input before inserting a row. Use `name ?? workflowName ?? runId` as display name. For background:

```ts
const promise = this.execute(state, executable, input);
this.active.set(runId, promise);
void promise.finally(() => this.active.delete(runId));
return { runId, status: "background" };
```

Map aborted workflow results into `ResultsInbox` status `failed`. Serialize summary with a 500-character bound and no thrown `JSON.stringify` on cyclic values.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-controller-start.test.mts test/workflow-save.test.mts test/workflow-source.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/runtime/controller.ts src/workflows/runtime/save.ts src/workflows/registry.ts test/helpers/workflow-controller-fixture.mts test/workflow-controller-start.test.mts test/workflow-save.test.mts
git commit -m "feat(spec-6-3): add workflow controller execution"
```

---

### Task 7: Controller controls and interactive checkpoints

**Files:**
- Modify: `src/workflows/runtime/controller.ts`
- Test: `test/workflow-controller-control.test.mts`

**Interfaces:**
- Produces `pause`, `resume`, `stop`, `respondToCheckpoint`, `settled`, and runtime hook construction per run.

- [ ] **Step 1: Write failing state-machine tests**

```ts
test("pause is cooperative and resume releases the next dispatch", async () => {
  const first = deferred<void>();
  const secondStarted = deferred<void>();
  let calls = 0;
  const { controller } = controllerFixture({ spawn: async () => {
    calls++;
    if (calls === 1) await first.promise;
    if (calls === 2) secondStarted.resolve();
    return child(`fl-${calls}`);
  }});
  const receipt = await controller.start({ script: TWO_AGENTS, mode: "auto" });
  controller.pause(receipt.runId);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await controller.resume(receipt.runId);
  await secondStarted.promise;
  assert.equal(calls, 2);
});

test("stop aborts active children and writes one abort terminal", async () => {
  const { controller, journal } = controllerFixture({ spawn: async (_p, opts) => {
    await new Promise((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true }));
    return child("never");
  }});
  const receipt = await controller.start({ script: ONE_AGENT, mode: "auto" });
  await controller.stop(receipt.runId);
  assert.equal(controller.getRun(receipt.runId)?.status, "aborted");
  assert.equal(journal.replay(receipt.runId).filter((e) => e.type === "wf:aborted").length, 1);
});

test("checkpoint stays pending until response and invalid transitions are actionable", async () => {
  const { controller } = controllerFixture();
  const receipt = await controller.start({ script: CHECKPOINT_SCRIPT, mode: "checkpointed" });
  await waitFor(() => controller.getRun(receipt.runId)?.status === "checkpoint");
  assert.match(controller.getRun(receipt.runId)?.checkpoint?.prompt ?? "", /approve/);
  controller.respondToCheckpoint(receipt.runId, true);
  await controller.settled(receipt.runId);
  assert.equal(controller.getRun(receipt.runId)?.status, "completed");
  assert.throws(() => controller.pause(receipt.runId), /cannot pause.*completed/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-controller-control.test.mts
```

- [ ] **Step 3: Implement strict control state machine**

Each active run owns `AbortController`, `PauseGate`, and optional checkpoint resolver. Runtime `onProgress` patches the store. Install `onCheckpoint` only when `WorkflowStartInput.mode === "checkpointed"`; auto runs retain headless checkpoint behavior. Interactive `onCheckpoint` sets status `checkpoint` and returns a Promise. `respondToCheckpoint` resolves once and clears pending state. Stop rejects checkpoint waiters, aborts the run signal, resumes paused waiters so they observe abort, awaits settlement, and preserves `aborted` against late completion.

Implement exact allowed/idempotent transitions from design §4.2. Every rejected transition includes operation, runId, and current status.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-controller-control.test.mts test/workflow-runner-control.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/runtime/controller.ts test/workflow-controller-control.test.mts
git commit -m "feat(spec-6-3): add workflow controls and checkpoints"
```

---

### Task 8: Journal hydration and restart resume

**Files:**
- Create: `src/workflows/runtime/hydrate.ts`
- Modify: `src/workflows/runtime/controller.ts`
- Test: `test/workflow-hydrate.test.mts`

**Interfaces:**
- Consumes Task 6 save/refresh behavior.
- Produces `hydrateWorkflowRuns` and controller `hydrate()` plus interrupted Resume/Stop behavior.

- [ ] **Step 1: Write failing hydration tests**

```ts
test("hydrate restores terminal and interrupted rows; resume unchanged reuses original source", async () => {
  const { controller, journal, store } = controllerFixture();
  journal.append("wf-done", started("wf-done", SOURCE));
  journal.append("wf-done", completedEvent("wf-done", "ok"));
  journal.append("wf-cut", started("wf-cut", SOURCE));
  journal.append("wf-cut", progress("wf-cut", "running"));
  controller.hydrate();
  assert.equal(store.get("wf-done")?.status, "completed");
  assert.equal(store.get("wf-cut")?.status, "interrupted");
  const receipt = await controller.resume("wf-cut");
  assert.equal(receipt.status, "background");
  assert.equal(controller.getRun(receipt.runId)?.resumeFromRunId, "wf-cut");
});

test("stop on interrupted journals abort without creating a live controller", async () => {
  const { controller, journal, store } = controllerFixture();
  journal.append("wf-cut", started("wf-cut", SOURCE));
  controller.hydrate();
  await controller.stop("wf-cut");
  assert.equal(store.get("wf-cut")?.status, "aborted");
  assert.equal(journal.replay("wf-cut").filter((e) => e.type === "wf:aborted").length, 1);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-hydrate.test.mts
```

- [ ] **Step 3: Implement hydration and interrupted controls**

`hydrateWorkflowRuns` scans journal files, replays each, and chooses the last progress/terminal event. It restores original source/mode from `wf:started`, progress logs from the latest snapshot, terminal result/error, and marks any non-terminal run `interrupted`. Controller Resume unchanged starts a new run with the original source and `resumeFromRunId`; Stop on interrupted writes `wf:aborted` for the old run.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-hydrate.test.mts test/workflow-registry.test.mts test/workflow-runner-resume.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/runtime/hydrate.ts src/workflows/runtime/controller.ts test/workflow-hydrate.test.mts
git commit -m "feat(spec-6-3): recover interrupted workflows"
```

---

### Task 9: Real fleet tool delegation and bounded keyword authorization

**Files:**
- Rewrite: `src/tools/fleet.ts`
- Create: `src/workflows/keyword.ts`
- Rewrite: `test/workflow-fleet-tool.test.mts`
- Test: `test/workflow-keyword.test.mts`

**Interfaces:**
- Consumes `WorkflowController` only.
- Produces `createFleetTool({ getController })` and `workflowKeywordHint(prompt)`; the getter prevents duplicate tool registration across session reloads.

- [ ] **Step 1: Write failing tool-delegation tests**

Use a fake controller recording method calls. Cover:

```ts
test("workflow validates script xor workflowName and delegates all options", async () => {
  const calls: WorkflowStartInput[] = [];
  const controller = fakeController({ start: async (input) => { calls.push(input); return { runId: "wf-1", status: "background" }; } });
  const tool = createFleetTool({ getController: () => controller });
  const res = await execute(tool, {
    action: "workflow", workflowName: "code-review", background: true,
    concurrency: 4, agentRetries: 2, agentTimeoutMs: 1000, tokenBudget: 4000,
  });
  assert.deepEqual(calls[0], {
    workflowName: "code-review", mode: "auto", background: true, concurrency: 4,
    agentRetries: 2, agentTimeoutMs: 1000, tokenBudget: 4000,
  });
  assert.equal(res.isError, undefined);
  assert.equal((await execute(tool, { action: "workflow", script: "x", workflowName: "y" })).isError, true);
});

test("workflow_control delegates list/status/pause/resume/stop without stub responses", async () => {
  const controller = fakeController();
  const tool = createFleetTool({ getController: () => controller });
  for (const control of ["list", "status", "pause", "resume", "stop"] as const) {
    const res = await execute(tool, { action: "workflow_control", control, ...(control === "list" ? {} : { runId: "wf-1" }) });
    assert.equal(res.isError, undefined);
    assert.equal(controller.calls.at(-1), control);
  }
});

test("foreground forwards the tool signal while background detaches", async () => {
  const controller = fakeController();
  const tool = createFleetTool({ getController: () => controller });
  const signal = new AbortController().signal;
  await tool.execute("c1", { action: "workflow", script: "return 1", background: false } as never, signal, null, null);
  assert.equal(controller.startRequests.at(-1)?.signal, signal);
  await tool.execute("c2", { action: "workflow", script: "return 1", background: true } as never, signal, null, null);
  assert.equal(controller.startRequests.at(-1), undefined);
});

test("bounded keyword authorizes workflow but identifiers do not", () => {
  assert.match(workflowKeywordHint("use a workflow for this") ?? "", /authorized/);
  assert.equal(workflowKeywordHint("src/workflow-editor.ts"), undefined);
  assert.equal(workflowKeywordHint("myworkflow_name"), undefined);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-fleet-tool.test.mts test/workflow-keyword.test.mts
```

- [ ] **Step 3: Replace stubs with thin controller calls**

TypeBox adds `workflowName` and `overwrite`; retain existing fields. Tool errors are caught and returned with `isError:true` and the original actionable message. The workflow action always passes `mode:"auto"`; `resumeFromRunId` calls `editAndResume(runId, script, "auto")`; when `background:false`, pass the tool execution signal as the controller request signal, while background starts deliberately detach. `list` returns public run summaries; `status` returns full public state; control results await and serialize the updated state/receipt. Remove journal/registry/runWorkflow/genRunId from `FleetToolDeps`. `getController()` throws `workflow runtime not initialized for this session` when called before session construction.

Implement keyword matching with `/(?:^|[^A-Za-z0-9_])workflows?(?=$|[^A-Za-z0-9_])/i` and return one bounded system hint. Do not force a tool call.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-fleet-tool.test.mts test/workflow-keyword.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/fleet.ts src/workflows/keyword.ts test/workflow-fleet-tool.test.mts test/workflow-keyword.test.mts
git commit -m "fix(spec-6-3): delegate fleet workflow actions to controller"
```

---

### Task 10: Combined Workflows panel item and action model

**Files:**
- Rewrite: `src/workflows/panel/workflows-items.ts`
- Modify: `src/workflows/panel/workflows-rows.ts`
- Rewrite: `test/workflow-panel-items.test.mts`

**Interfaces:**
- Produces `WorkflowPanelItem`, `WorkflowPanelAction`, `buildWorkflowPanelItems`, `actionsForWorkflowItem`, `parseWorkflowPanelKey`.
- Consumed by Tasks 11–12.

- [ ] **Step 1: Write failing pure-model tests**

Define local typed `definition(source, name)` and `run(runId, status, startedAt)` factories at the top of `test/workflow-panel-items.test.mts`; each fills every required Task 1/Task 2 field with deterministic defaults.

```ts
test("combined items show definitions before newest-first runs", () => {
  const items = buildWorkflowPanelItems({
    definitions: [definition("builtin", "code-review"), definition("project", "auth-audit")],
    runs: [run("wf-old", "completed", 1), run("wf-new", "running", 2)],
  });
  assert.deepEqual(items.map((i) => i.value), [
    "definition:auth-audit", "definition:code-review", "run:wf-new", "run:wf-old",
  ]);
  assert.match(items[0]!.label, /◇ auth-audit.*\[project\]/);
  assert.match(items[2]!.label, /▶ wf-new.*\[running\]/);
});

test("actions are context-sensitive", () => {
  assert.deepEqual(actionsForWorkflowItem({ kind: "definition", definition: definition("builtin", "x") }), ["run", "open"]);
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "paused", 1) }), ["open", "resume", "stop", "save"]);
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "checkpoint", 1) }), ["respond", "stop", "open"]);
  assert.deepEqual(actionsForWorkflowItem({ kind: "run", run: run("wf-1", "completed", 1) }), ["open", "edit-resume", "save", "view-result"]);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-panel-items.test.mts
```

- [ ] **Step 3: Implement discriminated item model**

Use values `definition:<name>` and `run:<runId>`. Shadowed definitions appear only once because registry output is already resolved. Sort definitions by source rank project=0/global=1/builtin=2, then name. Sort runs by `startedAt` descending. Render all statuses including queued/interrupted and bound descriptions/results to avoid line overflow. A run row appends only its latest bounded log line; View-result uses the retained bounded log list.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-panel-items.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/panel/workflows-items.ts src/workflows/panel/workflows-rows.ts test/workflow-panel-items.test.mts
git commit -m "feat(spec-6-3): model combined workflow panel rows"
```

---

### Task 11: FleetPanel live Workflows list and direct controls

**Files:**
- Modify: `src/panel/fleet-panel.ts`
- Create: `test/helpers/workflow-panel-fixture.mts`
- Test: `test/workflow-panel-control.test.mts`

**Interfaces:**
- `FleetPanelDeps` consumes `workflowController`, `workflowStore`, and `workflowRegistry`.
- Produces panel intents for host-only actions in Task 12.

- [ ] **Step 1: Write failing panel-control tests**

Create `test/helpers/workflow-panel-fixture.mts` exporting `panelFixture`, `openWorkflows`, `stripAnsi`, `definition`, `run`, `runningRun`, `pausedRun`, and a minimal structural Theme fake. `panelFixture` records controller calls, exposes store/registry plus `renderCount(): number`, counts invalidations, and returns `cleanup()`. Assert:

```ts
test("Workflows tab renders definitions before runs and refreshes on store mutation", () => {
  const { panel, store } = panelFixture();
  for (let i = 0; i < 7; i++) panel.handleInput("\t");
  assert.match(stripAnsi(panel.render(120).join("\n")), /code-review.*builtin/);
  store.set("wf-1", runningRun());
  assert.match(stripAnsi(panel.render(120).join("\n")), /wf-1.*running/);
});

test("pause resume stop keys call controller for selected run", () => {
  const { panel, controller } = panelFixture({ selected: pausedRun() });
  openWorkflows(panel);
  panel.handleInput("u");
  assert.deepEqual(controller.calls, [["resume", "wf-1"]]);
  panel.handleInput("x");
  assert.deepEqual(controller.calls.at(-1), ["stop", "wf-1"]);
});

test("closing panel unsubscribes workflow store", () => {
  const { panel, store, renderCount } = panelFixture();
  openWorkflows(panel);
  panel.handleInput("q");
  const renders = renderCount();
  store.set("wf-1", runningRun());
  assert.equal(renderCount(), renders);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-panel-control.test.mts
```

- [ ] **Step 3: Wire live state and direct controls**

Replace optional `workflowRuns?: Map` with required controller/store/registry dependencies after session startup. Subscribe to `workflowStore` beside existing run/bg subscriptions. Build list with `buildWorkflowPanelItems`.

Delete every `Task 13 wires…` notification. Directly call controller pause/resume/stop, await async Resume/Stop through a small `void action().catch(...)` handler, rebuild the list after settlement, and keep cursor on the selected run. Keys unavailable for the selected item's action set are ignored with a specific warning.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-panel-control.test.mts test/workflow-panel-items.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/panel/fleet-panel.ts test/helpers/workflow-panel-fixture.mts test/workflow-panel-control.test.mts
git commit -m "feat(spec-6-3): wire live workflow panel controls"
```

---

### Task 12: Panel host for Run/Open/Edit-and-resume/Save-as/View-result/Checkpoint

**Files:**
- Create: `src/workflows/panel-host.ts`
- Modify: `src/panel/fleet-panel.ts`
- Modify: `test/helpers/workflow-panel-fixture.mts`
- Test: `test/workflow-panel-host.test.mts`
- Extend: `test/workflow-panel-control.test.mts`

**Interfaces:**
- Produces `openWorkflowPanelLoop(deps, host): Promise<void>`, `WorkflowPanelHostContext`, and `WorkflowPanelIntent`.
- Consumed by Task 13 `/fleet` command.

- [ ] **Step 1: Write failing host-intent tests**

Extend `test/helpers/workflow-panel-fixture.mts` with `fakeUi`, `context`, `panelDeps`, and `terminalRun`. `fakeUi` consumes a typed queue of custom/editor/input/confirm results, records user messages and render calls, and throws on an unexpected UI operation. Cover:

```ts
test("edit-and-resume closes panel, opens editor, starts resume, then reopens", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "edit-resume", runId: "wf-old" } },
    { type: "editor", value: EDITED_SOURCE },
    { type: "custom", value: { action: "close" } },
  ]);
  const controller = fakeController({ getRun: () => terminalRun({ script: ORIGINAL_SOURCE }) });
  await openWorkflowPanelLoop(panelDeps(controller), context(ui));
  assert.deepEqual(controller.calls, [["editAndResume", "wf-old", EDITED_SOURCE, "checkpointed"]]);
  assert.equal(ui.customCount, 2);
});

test("save-as confirms overwrite and refreshes definitions", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "save", runId: "wf-1" } },
    { type: "input", value: "code-review" },
    { type: "confirm", value: true },
    { type: "custom", value: { action: "close" } },
  ]);
  const controller = fakeController({ saveCollision: true });
  await openWorkflowPanelLoop(panelDeps(controller), context(ui));
  assert.deepEqual(controller.calls.at(-1), ["save", { name: "code-review", source: ORIGINAL_SOURCE, overwrite: true }]);
});

test("non-empty Run prompt closes panel and sends bounded model authorization", async () => {
  const ui = fakeUi([
    { type: "custom", value: { action: "run", definitionName: "code-review", prompt: "audit this diff" } },
  ]);
  const ctx = context(ui);
  await openWorkflowPanelLoop(panelDeps(fakeController()), ctx);
  assert.match(ctx.sentUserMessages[0] ?? "", /audit this diff.*fleet workflow/s);
});
```

Also test: blank Run executes selected definition; Open definition shows bounded source; Open run emits an intent to the existing Runs viewer; View-result shows bounded result; checkpoint confirm/input/select responses call `respondToCheckpoint`; closing leaves checkpoint pending.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/workflow-panel-host.test.mts test/workflow-panel-control.test.mts
```

- [ ] **Step 3: Implement intent-returning panel + host loop**

Refactor the custom panel completion value from `void` to:

```ts
export type WorkflowPanelIntent =
  | { action: "close" }
  | { action: "run"; definitionName: string; prompt: string }
  | { action: "open-definition"; name: string }
  | { action: "open-child"; runId: string; childRunId: string }
  | { action: "edit-resume"; runId: string }
  | { action: "save"; runId: string }
  | { action: "view-result"; runId: string }
  | { action: "respond"; runId: string };
```

Define `WorkflowPanelHostContext` with the required UI methods plus an explicit `sendUserMessage(text: string): void` callback injected from the extension API. The panel keeps inline `Input` for Run prompt and Save name; multi-line edit exits to host `ui.editor`. The host loop calls `editAndResume(runId, editedSource, "checkpointed")` and reopens after editor/input/confirm actions. Blank Run calls `controller.start({ workflowName, mode:"checkpointed" })`. For model-generated Run, exit the loop and call the injected `sendUserMessage` callback with a bounded instruction to generate and execute through `fleet.workflow`. Never nest `ui.editor()` inside `ui.custom()`.

Open child delegates to the existing Runs viewer seam rather than adding a second conversation viewer. Bound source/result rendering to 50KB/2000 lines using Pi truncation utilities.

- [ ] **Step 4: Verify GREEN**

```bash
node --import tsx --test test/workflow-panel-host.test.mts test/workflow-panel-control.test.mts test/workflow-panel-items.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/panel-host.ts src/panel/fleet-panel.ts test/helpers/workflow-panel-fixture.mts test/workflow-panel-host.test.mts test/workflow-panel-control.test.mts
git commit -m "feat(spec-6-3): complete workflow panel actions"
```

---

### Task 13: `index.ts` construction + complete in-process integration

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tools/subagent.ts` only if shared dependency typing requires an additive workflow runtime field
- Create: `test/helpers/workflow-integration-harness.mts`
- Test: `test/workflow-integration.test.mts`
- Extend: `test/index-spec5a.test.mts` (existing extension-entry/import smoke)

**Interfaces:**
- Consumes all prior tasks.
- Produces the complete per-session runtime and keyword hook.

- [ ] **Step 1: Write failing integration tests**

Create `test/helpers/workflow-integration-harness.mts` exporting `createWorkflowIntegrationHarness`, `BUILTIN_DIR`, `BUILTIN_NAMES`, `LIFECYCLE_SCRIPT`, and `THREE_PARALLEL`. It constructs real journal/store/controller/registry/run-registry objects with deterministic fake model children; no helper referenced below may remain undefined. Its prompt router returns: JSON string arrays for `Find unique sources`/`List files`; `real: confirmed` for independent-review prompts; `{"score":8,"reason":"sound"}` for judge prompts; a 120+ character synthesis for synthesis/revision prompts; and a normal non-empty string otherwise. The integration harness must assert actual behavior, not only import syntax:

```ts
test("tool to controller to builtin runner updates store and child registry", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR });
  const tool = createFleetTool({ getController: () => app.controller });
  const res = await execute(tool, { action: "workflow", workflowName: "code-review", background: false });
  assert.equal(res.isError, undefined);
  const runId = (res.details as { runId: string }).runId;
  assert.equal(app.store.get(runId)?.status, "completed");
  assert.ok((app.store.get(runId)?.childRunIds.length ?? 0) >= 1);
  assert.ok(app.runRegistry.list().some((r) => app.store.get(runId)?.childRunIds.includes(r.runId)));
});

test("all five builtins execute by name", async () => {
  const app = await createWorkflowIntegrationHarness({ builtinDir: BUILTIN_DIR });
  for (const workflowName of BUILTIN_NAMES) {
    const result = await app.controller.start({ workflowName, mode: "auto", background: false, maxAgents: 100 });
    assert.equal(result.status, "completed", `${workflowName}: ${"error" in result ? result.error : ""}`);
    if (workflowName === "deep-research" || workflowName === "codebase-audit") {
      assert.ok(JSON.stringify(result.result).includes("source-") || JSON.stringify(result.result).includes("file-"));
    }
  }
});

test("lifecycle step uses real adapter and parallel run reaches configured concurrency", async () => {
  const app = await createWorkflowIntegrationHarness({ measuredSpawn: true });
  const lifecycle = await app.controller.start({ script: LIFECYCLE_SCRIPT, mode: "auto", background: false });
  assert.equal(lifecycle.status, "completed");
  const parallel = await app.controller.start({ script: THREE_PARALLEL, mode: "auto", background: false, concurrency: 2 });
  assert.equal(parallel.status, "completed");
  assert.equal(app.maxActiveChildren, 2);
});
```

Also cover Save-as shadowing, background inbox, pause/resume/stop, checkpoint response, edit-and-resume cache, and restart hydration in this one end-to-end test file.

- [ ] **Step 2: Verify RED against current partial index wiring**

```bash
node --import tsx --test test/workflow-integration.test.mts test/index*.test.mts
```

Expected: FAIL until `index.ts` supplies controller/store/adapters/lifecycle and the panel host.

- [ ] **Step 3: Replace partial workflow wiring with construction-only wiring**

In `session_start`:

1. discover definitions and create a refreshable `WorkflowRegistry`;
2. create `WorkflowJournal`, `WorkflowRunStore`, production adapter factory, and `WorkflowController`;
3. inject `ResultsInbox`, parent cwd/model registries, lifecycle registries/deps, worktree service, RunLog, RunRegistry, and notification callbacks;
4. call `controller.hydrate()`;
5. assign the controller to `activeWorkflowController`; register `createFleetTool({ getController: () => activeWorkflowController })` once outside `session_start`;
6. expose controller/store/registry to `openWorkflowPanelLoop`;
7. remove the old `wfRunnerDeps`, unused `workflowRuns` map seam, journal-only control tool, and auto-continue checkpoint stub.

In `/fleet`, await `openWorkflowPanelLoop` and inject `sendUserMessage: (text) => pi.sendUserMessage(text)`; do not call a nonexistent command-context method. Register one `before_agent_start` handler that gathers the non-empty `resultsInbox.renderHint()` and `workflowKeywordHint(event.prompt)`, then appends both bounded hints to `event.systemPrompt`; when both are empty it returns `undefined`. Extend `test/index-spec5a.test.mts` to assert a pushed workflow result makes the next hook output include `fleet results ready` without consuming the inbox. In `session_shutdown`, abort active workflow runs and dispose subscriptions without converting already-terminal runs.

- [ ] **Step 4: Verify complete integration**

```bash
node --import tsx --test test/workflow-integration.test.mts test/index*.test.mts
pnpm typecheck
pnpm test:run --test-timeout=30000
rg -n "Task 13 wires|pause/resume/stop stub|workflowRuns\?: Map" src && exit 1 || true
```

Expected: all tests pass; grep finds no partial-workflow markers.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/tools/subagent.ts test/helpers/workflow-integration-harness.mts test/workflow-integration.test.mts test/index-spec5a.test.mts
git commit -m "fix(spec-6-3): complete workflow runtime integration"
```

---

### Task 14: Final review + seven mandatory local real-Pi smokes

**Files:**
- Modify only files required by review/smoke findings
- Update: `.superpowers/sdd/progress.md` (ignored run ledger)
- Update: `.superpowers/sdd/dogfood-notes.md` (ignored dogfood ledger)

**Interfaces:**
- Consumes the completed branch.
- Produces release evidence; no release side effects.

- [ ] **Step 1: Fresh whole-branch verification**

```bash
pnpm typecheck
pnpm test:run --test-timeout=30000
git diff --check 51956e0..HEAD
git status --short --branch
```

Expected: typecheck exit 0; all tests pass; no whitespace errors; no unexpected working-tree changes.

- [ ] **Step 2: Final whole-branch review**

Dispatch the most capable available reviewer over `51956e0..HEAD`, the parent spec, and the completion amendment. Require explicit spec-to-code traceability for every amendment section—not only type consistency. Fix all Critical/Important findings with one focused fix wave and re-run Step 1.

- [ ] **Step 3: Spawn local extension smoke window**

```bash
pi --no-extensions -e ./src/index.ts --no-session --approve
```

Use the `term` tool at 140×45 or larger. Leave the final window inspectable and record its `windowName`.

- [ ] **Step 4: Smoke 1 — definitions before runs**

Open `/fleet`, navigate to Workflows, and verify all five names appear before any run:

```txt
code-review
deep-research
adversarial-review
multi-perspective
codebase-audit
```

- [ ] **Step 5: Smoke 2 — builtin live run**

Run `code-review` on a small real diff. Verify:

- Workflows row transitions queued → running → completed;
- phase strip advances Review → Verify;
- agent/cached/rerun counts update;
- child agents appear in Fleet and Runs;
- tokens/cost equal child totals.

- [ ] **Step 6: Smoke 3 — pause/resume/stop**

Run a three-agent workflow at concurrency 1. Pause after the first child starts, confirm the next child does not start, Resume, then Stop before terminal completion. Verify one `wf:aborted` event and no later completion.

- [ ] **Step 7: Smoke 4 — edit-and-resume**

Complete a two-call workflow, edit only the second prompt, and resume. Verify first call is cached and second is rerun in the row and journal.

- [ ] **Step 8: Smoke 5 — Save-as + shadowing**

Save a project workflow with the same name as a builtin using explicit confirmation. Verify the project definition replaces the builtin row and execution uses the project body. Restore/remove the smoke file after evidence capture.

- [ ] **Step 9: Smoke 6 — interactive checkpoint**

Run a workflow containing confirm and input checkpoints. Verify the row enters checkpoint state, closing/reopening the panel preserves it, responses continue execution, and Stop rejects a pending checkpoint cleanly.

- [ ] **Step 10: Smoke 7 — restart recovery**

Start a multi-call workflow, terminate Pi mid-run, restart the local extension, verify an interrupted row appears, then Resume unchanged and complete via cache reuse.

- [ ] **Step 11: Final evidence commit if fixes were needed**

If the review or smokes required source changes:

```bash
git add -u
git add src/workflows src/index.ts src/panel/fleet-panel.ts src/tools/fleet.ts src/engine/spawnSubagent.ts test/helpers test/workflow-*.test.mts test/index*.test.mts
git commit -m "fix(spec-6-3): resolve release smoke findings"
pnpm typecheck
pnpm test:run --test-timeout=30000
git push origin feat/spec-6-3-workflows
gh pr checks 21 --watch
```

If no tracked changes were needed, do not create an empty commit. Record final evidence in the ignored progress/dogfood ledgers and report the inspectable smoke window name.

---

### Task 15: Release `v0.12.0`

**Files:**
- Verify: `package.json` remains `0.12.0`
- Modify after publication: `~/dotfiles/pi/agent/settings.json`
- Update after publication: `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-fleet/handoff-pointer.md`

**Interfaces:**
- Consumes Task 14's verified branch, smoke evidence, and explicit RECTOR approval.
- Produces merged PR #21, tag/GitHub Release/npm `0.12.0`, a one-line staged Pi settings bump, published-package smoke evidence, and durable handoff state.

**Precondition:** RECTOR explicitly approves the irreversible release after Task 14 evidence is presented.

- [ ] **Step 1: Verify PR and package state**

```bash
git status --short --branch
grep '"version": "0.12.0"' package.json
gh pr checks 21
gh pr view 21 --json state,mergeable,headRefOid,baseRefOid,url
npm view @getpipher/armory-fleet version --json
```

Expected: clean branch; version 0.12.0; checks green; PR open/mergeable; npm still 0.11.1.

- [ ] **Step 2: Merge using the required merge commit flow**

```bash
gh pr merge 21 --merge --delete-branch
git checkout main
git pull --ff-only origin main
pnpm typecheck
pnpm test:run --test-timeout=30000
```

Expected: PR merged; local main contains the merge; merged tests pass.

- [ ] **Step 3: Tag and trigger publication**

```bash
git update-ref refs/tags/v0.12.0 refs/heads/main
git push --force origin v0.12.0
gh run list --workflow Release --limit 3
gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

- [ ] **Step 4: Verify immutable release outputs**

```bash
npm view @getpipher/armory-fleet version --json
gh release view v0.12.0 --json tagName,isDraft,isPrerelease,url
git ls-remote --tags origin refs/tags/v0.12.0
```

Expected: npm version `0.12.0`; GitHub Release exists and is neither draft nor prerelease; remote tag points to merged main.

- [ ] **Step 5: Bump Pi settings through the real dotfiles target**

Edit `~/dotfiles/pi/agent/settings.json`, replacing only `npm:@getpipher/armory-fleet@0.11.1` with `npm:@getpipher/armory-fleet@0.12.0`. The dotfiles checkout is already dirty—including this same file—so stage a one-line patch against HEAD instead of `git add`-ing the whole working file:

```bash
DOT="$HOME/dotfiles"
BASE="$(mktemp)"
TARGET="$(mktemp)"
PATCH="$(mktemp)"
git -C "$DOT" show HEAD:pi/agent/settings.json > "$BASE"
cp "$BASE" "$TARGET"
node -e 'const fs=require("fs"); const p=process.argv[1]; const old="npm:@getpipher/armory-fleet@0.11.1"; const next="npm:@getpipher/armory-fleet@0.12.0"; const s=fs.readFileSync(p,"utf8"); if(s.split(old).length!==2) process.exit(1); fs.writeFileSync(p,s.replace(old,next));' "$TARGET"
python3 - "$BASE" "$TARGET" "$PATCH" <<'PY'
import difflib, pathlib, sys
base = pathlib.Path(sys.argv[1]).read_text().splitlines(keepends=True)
target = pathlib.Path(sys.argv[2]).read_text().splitlines(keepends=True)
patch = difflib.unified_diff(base, target, fromfile="a/pi/agent/settings.json", tofile="b/pi/agent/settings.json")
pathlib.Path(sys.argv[3]).write_text("".join(patch))
PY
node -e 'const fs=require("fs"); const p=process.argv[1]; const old="npm:@getpipher/armory-fleet@0.11.1"; const next="npm:@getpipher/armory-fleet@0.12.0"; const s=fs.readFileSync(p,"utf8"); if(s.split(old).length!==2) process.exit(1); fs.writeFileSync(p,s.replace(old,next));' "$DOT/pi/agent/settings.json"
git -C "$DOT" apply --cached "$PATCH"
test "$(git -C "$DOT" diff --cached --name-only)" = "pi/agent/settings.json"
git -C "$DOT" diff --cached --check
git -C "$DOT" diff --cached -- pi/agent/settings.json
git -C "$DOT" commit -m "chore(pi): bump armory-fleet to 0.12.0"
git -C "$DOT" push origin main
rm -f "$BASE" "$TARGET" "$PATCH"
```

Before committing, inspect the cached diff and confirm it contains exactly the armory-fleet version replacement. Do not stage or commit the pre-existing unrelated dotfiles changes.

- [ ] **Step 6: Published-package smoke**

Start a fresh Pi process using installed settings, open `/fleet → Workflows`, verify five builtins, and run one bounded workflow. Leave the window inspectable and report its name.

- [ ] **Step 7: Update durable handoff memory**

Update `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-fleet/handoff-pointer.md` with:

- SPEC-6-3 COMPLETE;
- PR #21 merged;
- tag/release/npm 0.12.0 verified;
- local and published smoke window names;
- deferred post-v0.12.0 items and issue #20.

---

## Self-Review

### Spec coverage

| Amendment section | Tasks |
|---|---|
| §3 architecture/controller/store/hooks | 2, 3, 6, 7 |
| §4 start/control/concurrency/retry/lifecycle/accounting | 3–7 |
| §5 progress journal/hydration | 3, 8 |
| §6 save/source normalization | 1, 8 |
| §7 tool/keyword | 9, 13 |
| §8 combined view/all actions/checkpoints | 10–12 |
| §9 construction-only index wiring | 13 |
| §10 errors/security | 1, 6–9, 12–13 |
| §11 unit/integration/term tests | every task; 13–14 |
| §12 release gate | 14–15 |
| §13 deferrals preserved | global constraints; no task implements deferred scope |

### Type consistency

- `WorkflowRunState` is defined once in Task 2 and consumed by journal, controller, panel, and tool.
- `WorkflowProgressEvent` is defined once in Task 2; Task 3 adds it to journal and hooks.
- `WorkflowController` is the only runtime API consumed by Tasks 9–13.
- Source execution always uses Task 1 `.executable`; editing/saving always uses `.sourceText`.
- Task 5 adapters return the existing `WorkflowRunDeps.spawn` and `runLifecycle` shapes consumed by the runner.
- Background results reuse existing `ResultsInbox.RunResult` without adding a second inbox.
- Panel host is the only owner of nested UI sequencing; FleetPanel never calls `ctx.ui.editor()` inside `ctx.ui.custom()`.

### Placeholder scan

The plan contains no TBD/TODO/FIXME/HACK, no undefined implementation placeholders, and every production behavior maps to an exact task, interface, test, command, and commit boundary.
