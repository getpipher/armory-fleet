# SPEC-6-4 Event-Bus RPC + Live Conversation Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give armory-fleet a public surface — a two-tier event stream on `pi.events` plus an RPC verb set (`spawn`/`steer`/`observe`/`abort`/`status`) — and make the Runs-tab timeline overlay live.

**Architecture:** `FleetEventBus` subscribes to `RunLog` + `RunJournal` appends (both gain `subscribe()`) and publishes the frozen `fleet:*` taxonomy. `RpcServer` answers `fleet:rpc` requests with correlation IDs; replay is served from the journals themselves (no ring buffer). Control verbs gate on `ARMORY_FLEET_RPC_CONTROL` and ride `RunRecord.session` (the existing 5b-4 `LiveSessionHandle`). The live viewer is the timeline overlay hydrating from `RunLog.replay()` + live appends via `RunLog.subscribe`.

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build step), node:test (`test/*.test.mts` only), pi extension API (`pi.events`, `pi.registerTool`), typebox for tool schemas.

**Spec:** `docs/superpowers/specs/2026-08-29-spec-6-4-event-bus-rpc-live-viewer-design.md` (read it first — §2 locked decisions, §3 frozen surface).

## Global Constraints

- Tests live in `test/*.test.mts` ONLY (`pnpm test:run` scans nothing else) and import from `../src/...`.
- Before EVERY commit: `pnpm typecheck` AND `pnpm test:run`, both as standalone commands (never `gate | tail && cmd` — exit-code masking, gotcha #10). Set a bash `timeout` on both.
- Tests must NOT assert environment-dependent preconditions (CI has zero configured providers/models — the #75 BLOCK). Never assert "a model is available".
- Frozen surface: channel names (`fleet:run:started`, `fleet:run:ended`, `fleet:phase:started`, `fleet:phase:completed`, `fleet:phase:failed`, `fleet:child:message`, `fleet:child:tool`, `fleet:rpc`, `fleet:rpc:result`), envelope `{ runId, seq, ts, ...payload }`, and error codes are API — Task 3/4 tests pin them verbatim; any rename must fail those tests loudly.
- Excerpt policy on the public fine tier is the journal's (`excerpt()` — args≤200ch, result≤500ch, errors in full). Do not re-implement truncation; the bus publishes the already-excerpted `RunLog` event fields.
- Resource cleanup: every `subscribe()` return value must be unsubscribed on dispose (`session_shutdown`, overlay close, panel close).
- A bus/RPC failure must NEVER break a run: wrap all fan-out and dispatch in try/catch.
- 2-space indent, no AI attribution anywhere, no TODO/FIXME left behind.

---

### Task 1: Store subscriptions — `RunLog.subscribe` + `RunJournal.subscribe`

**Files:**
- Modify: `src/runtime/run-log.ts` (class `RunLog`)
- Modify: `src/runtime/run-journal.ts` (class `RunJournal`)
- Test: `test/store-subscribe.test.mts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `RunLog.subscribe(fn: (runId: string, event: RunLogEvent) => void): () => void` and `RunJournal.subscribe(fn: (runId: string, event: JournalEvent) => void): () => void`. Both fire synchronously inside `append(runId, event)` after a successful write, in append order, once per event. Returns an unsubscribe function. A throwing subscriber must not fail the append or other subscribers.

- [ ] **Step 1: Write the failing test**

Create `test/store-subscribe.test.mts`:

```typescript
// test/store-subscribe.test.mts — SPEC-6-4 Task 1: RunLog/RunJournal subscribe fan-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, type RunLogEvent } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";

test("RunLog.subscribe fires on append with (runId, event), in append order", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runlog-sub-"));
  try {
    const log = new RunLog(join(dir, "conversations"));
    const seen: Array<{ runId: string; event: RunLogEvent }> = [];
    const unsub = log.subscribe((runId, event) => seen.push({ runId, event }));
    log.append("fl-1", { type: "run:meta", runId: "fl-1", agent: "scout", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
    log.append("fl-1", { type: "message", role: "assistant", text: "hi", turnIndex: 0 });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].runId, "fl-1");
    assert.equal(seen[0].event.type, "run:meta");
    assert.equal(seen[1].event.type, "message");
    unsub();
    log.append("fl-1", { type: "message", role: "assistant", text: "gone", turnIndex: 1 });
    assert.equal(seen.length, 2, "unsubscribed listener must not fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunLog.append survives a throwing subscriber (event still persisted, others still notified)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runlog-thrown-"));
  try {
    const log = new RunLog(join(dir, "conversations"));
    let good = 0;
    log.subscribe(() => { throw new Error("listener boom"); });
    log.subscribe(() => { good++; });
    log.append("fl-1", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
    assert.equal(good, 1, "second subscriber still fires after the first threw");
    assert.equal(log.replay("fl-1").length, 1, "event still persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal.subscribe fires on append with (runId, event)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-journal-sub-"));
  try {
    const journal = new RunJournal(join(dir, "runs"));
    const seen: Array<{ runId: string; type: string }> = [];
    const unsub = journal.subscribe((runId, event) => seen.push({ runId, type: event.type }));
    journal.append("fl-2", { type: "run:started", runId: "fl-2", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
    journal.append("fl-2", { type: "phase:started", phase: "impl", ts: 2 });
    assert.deepEqual(seen, [
      { runId: "fl-2", type: "run:started" },
      { runId: "fl-2", type: "phase:started" },
    ]);
    unsub();
    journal.append("fl-2", { type: "phase:completed", phase: "impl", summary: "s", paths: [], ts: 3 });
    assert.equal(seen.length, 2, "unsubscribed listener must not fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/store-subscribe.test.mts` (timeout 60s)
Expected: FAIL — `log.subscribe is not a function` (same for journal).

- [ ] **Step 3: Implement**

In `src/runtime/run-log.ts`, inside class `RunLog`, add a subscriber set + method, and fire in `append`:

```typescript
  /** SPEC-6-4: append fan-out (the FleetEventBus + live overlay subscribe). Fired synchronously
   *  after a successful write, in append order. A throwing subscriber never fails the append. */
  private readonly subscribers = new Set<(runId: string, event: RunLogEvent) => void>();

  subscribe(fn: (runId: string, event: RunLogEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
```

Change the `append` body to notify after the write:

```typescript
  append(runId: string, event: RunLogEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(runId), JSON.stringify(event) + "\n", "utf8");
    } catch {
      // best-effort: the run is the product; the journal is the index. Never fail the run.
      return;
    }
    for (const fn of this.subscribers) {
      try { fn(runId, event); } catch { /* a faulty subscriber must not fail the append or others */ }
    }
  }
```

(Note the early `return` on write failure: subscribers only see successfully persisted events.)

In `src/runtime/run-journal.ts`, same pattern inside class `RunJournal`:

```typescript
  /** SPEC-6-4: append fan-out (FleetEventBus phase tier). Same contract as RunLog.subscribe. */
  private readonly subscribers = new Set<(runId: string, event: JournalEvent) => void>();

  subscribe(fn: (runId: string, event: JournalEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
```

And in `RunJournal.append`, after the `appendFileSync` line:

```typescript
    for (const fn of this.subscribers) {
      try { fn(runId, event); } catch { /* a faulty subscriber must not fail the append or others */ }
    }
```

(RunJournal.append has no try/catch today — leave the write as-is; only wrap the subscriber loop.)

- [ ] **Step 4: Run the test to verify it passes + full gates**

Run: `npx tsx --test test/store-subscribe.test.mts` → PASS (3 tests).
Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass, 742+3.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/run-log.ts src/runtime/run-journal.ts test/store-subscribe.test.mts
git commit -m "feat: RunLog/RunJournal append fan-out via subscribe() (SPEC-6-4 T1)"
```

---

### Task 2: `spawnSubagent` `runId?`/`mode?` opts + `RunMetaEvent.mode` + origin threading

**Files:**
- Modify: `src/runtime/run-log.ts` (`RunMetaEvent` — add `mode?`)
- Modify: `src/engine/spawnSubagent.ts` (opts interface + both mint sites + the `run:meta` append)
- Modify: `src/runtime/async-runner.ts` (`RunBackgroundOpts.origin?` + `RunLifecycleOpts.fleetMode?` + pass-through)
- Modify: `src/index.ts` (bg lifecycle adapter spawn → `mode: opts.fleetMode ?? "background"`; scheduler fire → `origin: "scheduled"`; workflow spawn → `mode: "workflow"`)
- Test: `test/spawn-mode-runid.test.mts`

**Interfaces:**
- Consumes: Task 1 (nothing direct — journaling only).
- Produces:
  - `RunMetaEvent.mode?: "foreground" | "background" | "scheduled" | "workflow"` — written by `spawnSubagent` as `opts.mode ?? "foreground"`.
  - `spawnSubagent` opts gain `runId?: string` (both mint sites become `runId = opts.runId ?? genRunId()`) and `mode?: string` (same union). Absent → today's behavior exactly.
  - `RunBackgroundOpts.origin?: "background" | "scheduled"` → `runBackgroundInPlace` passes `fleetMode: opts.origin ?? "background"` into the `runLifecycle` opts object → the bg adapter's spawn lambda reads `opts.fleetMode`.
- Rationale: `fleet:run:started.mode` (Task 3) is sourced from `RunMetaEvent.mode`. The RPC `spawn` verb (Task 4) needs a pre-minted runId to reply synchronously.

- [ ] **Step 1: Write the failing test**

Create `test/spawn-mode-runid.test.mts`:

```typescript
// test/spawn-mode-runid.test.mts — SPEC-6-4 Task 2: runId?/mode? opts surface on run:meta.
// Uses a FAKE session (never a real model — CI has no providers) through spawnSubagent's
// factory seam: opts.childFactory is the injection point used by existing unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { RunLog } from "../src/runtime/run-log.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";
import type { ChildSession, ChildSessionEvent } from "../src/engine/spawnSubagent.ts";

/** Minimal fake ChildSession: emits one assistant message_end then ends. */
function fakeSession(): ChildSession {
  return {
    subscribe(handler: (e: ChildSessionEvent) => void) {
      queueMicrotask(() => {
        handler({ type: "message_end", message: { role: "assistant", content: "done", usage: { total: 1 } } } as ChildSessionEvent);
        handler({ type: "turn_end" } as ChildSessionEvent);
      });
      return () => {};
    },
    prompt: async () => {},
  } as unknown as ChildSession;
}

function baseDeps(runLog: RunLog) {
  return {
    registry: new Map(),
    todoSync: { noteRunStarted: async () => {}, noteRunEnded: async () => {}, revertToOpen: async () => {} } as never,
    runRegistry: new RunRegistry(),
    lock: createSingleSlotLock(),
    backendRegistry: {
      get: () => ({ create: async () => fakeSession() }),
    } as never,
    parentModel: { provider: "Test", id: "test-model" },
    parentCwd: process.cwd(),
    runLog,
  };
}

test("spawnSubagent honors runId? + mode? opts on the run:meta event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-spawn-mode-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const metas: Array<Record<string, unknown>> = [];
    runLog.subscribe((_runId, e) => { if (e.type === "run:meta") metas.push(e as unknown as Record<string, unknown>); });
    await spawnSubagent({
      ...baseDeps(runLog),
      agent: "scout", task: "t",
      runId: "fl-preminted",
      mode: "background",
    } as never);
    assert.equal(metas.length, 1);
    assert.equal(metas[0].runId, "fl-preminted", "pre-minted runId must be used verbatim");
    assert.equal(metas[0].mode, "background");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnSubagent defaults mode to foreground and mints a runId when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-spawn-default-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const metas: Array<Record<string, unknown>> = [];
    runLog.subscribe((_runId, e) => { if (e.type === "run:meta") metas.push(e as unknown as Record<string, unknown>); });
    const res = await spawnSubagent({ ...baseDeps(runLog), agent: "scout", task: "t" } as never);
    assert.equal(metas.length, 1);
    assert.equal(metas[0].runId, res.runId, "minted runId matches the result");
    assert.equal(metas[0].mode, "foreground");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

NOTE for the implementer: this test follows the shape of the EXISTING spawnSubagent unit tests — open `test/` and find one (grep `spawnSubagent(` in `test/*.test.mts`); if the factory seam or fake session there differs (e.g. `backendRegistry` stub shape, todoSync port methods), COPY that test's fixture exactly and only add the `runId`/`mode` assertions. The fake here must satisfy the real `ChildSession`/port types — run typecheck and fix the fixture against the real types, never weaken the assertion on `mode`/`runId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/spawn-mode-runid.test.mts` (timeout 60s)
Expected: FAIL — `runId`/`mode` ignored (metas[0].runId is a freshly minted `fl-…`, mode undefined). If the fixture itself fails to compile, fix the fixture per the NOTE, keep the assertions, re-run.

- [ ] **Step 3: Implement**

1. `src/runtime/run-log.ts` — `RunMetaEvent` gains:

```typescript
  /** SPEC-6-4: dispatch origin — fleet:run:started `mode`. Default "foreground". */
  mode?: "foreground" | "background" | "scheduled" | "workflow";
```

2. `src/engine/spawnSubagent.ts`:
   - The opts interface (the one with `onEvent?` at ~line 134) gains:

```typescript
  /** SPEC-6-4: pre-minted runId (RPC spawn replies before the detached spawn resolves). Absent → mint. */
  runId?: string;
  /** SPEC-6-4: dispatch origin for RunMetaEvent.mode. Default "foreground". */
  mode?: "foreground" | "background" | "scheduled" | "workflow";
```

   - Line ~244 and ~250: both `runId = genRunId();` → `runId = opts.runId ?? genRunId();`
   - Line ~404 (the `run:meta` append): add `mode: opts.mode ?? "foreground",` to the object literal (after `sessionCwd: opts.parentCwd,`).

3. `src/runtime/async-runner.ts`:
   - `RunBackgroundOpts` (top of file) gains:

```typescript
  /** SPEC-6-4: dispatch origin for fleet:run:started `mode`. "scheduled" when fired by the scheduler. */
  origin?: "background" | "scheduled";
```

   - `RunLifecycleOpts` (same file, line 24) gains:

```typescript
  /** SPEC-6-4: origin threading to the bg lifecycle spawn adapter (→ spawnSubagent mode → run:meta). */
  fleetMode?: "background" | "scheduled";
```

   - In `runBackgroundInPlace`, the `deps.runLifecycle(task, opts.lifecycle, { runId, worktreePath: isolated?.worktreePath, branch: isolated?.branch, mode: opts.mode, entryCwd: … })` call gains `fleetMode: opts.origin ?? "background",`.

4. `src/index.ts`:
   - The bg lifecycle adapter's spawn lambda (`asyncRunLifecycle`, ~line 273 — the `spawn: withModelFallbackRetry(async (o) => spawnSubagent({ … }))` inside it): add `mode: opts.fleetMode ?? "background",` to the `spawnSubagent({...})` literal. (`opts` here is the adapter's `RunLifecycleOpts` closure param.)
   - The scheduler `onFire` callback (~line 393): whatever it passes to `runBackground(...)` gains `origin: "scheduled",`.
   - The workflow `deps.spawn` lambda (~line 583): add `mode: "workflow",` to its `spawnSubagent({...})` literal.

- [ ] **Step 4: Run gates**

Run: `npx tsx --test test/spawn-mode-runid.test.mts` → PASS (2 tests).
Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass (existing spawnSubagent tests must be untouched-green; the default path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/run-log.ts src/engine/spawnSubagent.ts src/runtime/async-runner.ts src/index.ts test/spawn-mode-runid.test.mts
git commit -m "feat: spawnSubagent runId?/mode? opts + RunMetaEvent.mode + origin threading (SPEC-6-4 T2)"
```

---

### Task 3: `FleetEventBus` — the frozen taxonomy publisher

**Files:**
- Create: `src/rpc/event-bus.ts`
- Test: `test/fleet-event-bus.test.mts`

**Interfaces:**
- Consumes: Task 1 (`subscribe`), Task 2 (`RunMetaEvent.mode`).
- Produces (frozen — pinned by this task's tests):

```typescript
export type FleetChannel =
  | "fleet:run:started" | "fleet:run:ended"
  | "fleet:phase:started" | "fleet:phase:completed" | "fleet:phase:failed"
  | "fleet:child:message" | "fleet:child:tool";
export interface FleetEnvelope { runId: string; seq: number; ts: number; [key: string]: unknown }
export interface FleetEventBusDeps {
  runLog: Pick<RunLog, "subscribe">;
  journal: Pick<RunJournal, "subscribe">;
  emit: (channel: FleetChannel, payload: FleetEnvelope) => void;
}
export class FleetEventBus {
  constructor(deps: FleetEventBusDeps);
  dispose(): void;
}
```

- `seq` is per-run monotonic, ONE SPACE PER SOURCE STORE: RunLog-derived channels count RunLog append order; `fleet:phase:*` counts journal append order. Replay (Task 4) reconstructs the same seqs from the same orders.
- Envelope `ts` = publish time (`Date.now()` at translation).
- `dispose()` unsubscribes from both stores.

- [ ] **Step 1: Write the failing test**

Create `test/fleet-event-bus.test.mts`:

```typescript
// test/fleet-event-bus.test.mts — SPEC-6-4 Task 3: the frozen fleet:* taxonomy.
// These assertions pin channel names + payload shapes VERBATIM (spec §3.1). A rename or
// reshaping must break this file loudly — that is the point (frozen surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { FleetEventBus, type FleetChannel, type FleetEnvelope } from "../src/rpc/event-bus.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bus-"));
  const runLog = new RunLog(join(dir, "conversations"));
  const journal = new RunJournal(join(dir, "runs"));
  const emitted: Array<{ channel: FleetChannel; payload: FleetEnvelope }> = [];
  const bus = new FleetEventBus({
    runLog, journal,
    emit: (channel, payload) => emitted.push({ channel, payload }),
  });
  return { dir, runLog, journal, emitted, bus };
}

test("run:meta → fleet:run:started with the frozen payload shape (incl. mode default)", () => {
  const h = harness();
  try {
    h.runLog.append("fl-a", { type: "run:meta", runId: "fl-a", agent: "scout", model: "Test/m", task: "do it", startedAt: 1000, track: true, todoId: null });
    assert.equal(h.emitted.length, 1);
    const { channel, payload } = h.emitted[0];
    assert.equal(channel, "fleet:run:started");
    assert.equal(payload.runId, "fl-a");
    assert.equal(payload.seq, 1);
    assert.equal(typeof payload.ts, "number");
    assert.deepEqual(
      { agent: payload.agent, model: payload.model, cwd: payload.cwd, sessionCwd: payload.sessionCwd, mode: payload.mode, task: payload.task },
      { agent: "scout", model: "Test/m", cwd: undefined, sessionCwd: undefined, mode: "foreground", task: "do it" },
    );
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("message/tool appends → fleet:child:* with journal-excerpted fields, seq continues per run", () => {
  const h = harness();
  try {
    h.runLog.append("fl-b", { type: "message", role: "assistant", text: "hello", turnIndex: 0 });
    h.runLog.append("fl-b", { type: "tool", toolName: "edit", args: '{"path":"a.ts"}', result: "ok", isError: false, turnIndex: 0 });
    assert.equal(h.emitted.length, 2);
    assert.equal(h.emitted[0].channel, "fleet:child:message");
    assert.deepEqual({ role: h.emitted[0].payload.role, text: h.emitted[0].payload.text }, { role: "assistant", text: "hello" });
    assert.equal(h.emitted[1].channel, "fleet:child:tool");
    assert.deepEqual(
      { toolName: h.emitted[1].payload.toolName, args: h.emitted[1].payload.args, result: h.emitted[1].payload.result, isError: h.emitted[1].payload.isError },
      { toolName: "edit", args: '{"path":"a.ts"}', result: "ok", isError: false },
    );
    assert.equal(h.emitted[0].payload.seq, 1);
    assert.equal(h.emitted[1].payload.seq, 2, "seq is per-run monotonic across child events");
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("run:ended → fleet:run:ended with status/error/filesTouched/toolCallCount/durationMs", () => {
  const h = harness();
  try {
    h.runLog.append("fl-c", { type: "run:meta", runId: "fl-c", agent: "scout", model: "m", task: "t", startedAt: 1000, track: true, todoId: null });
    h.runLog.append("fl-c", { type: "run:ended", runId: "fl-c", status: "failed", endedAt: 2500, tokenTotal: 10, error: "model 404", toolCallCount: 0, filesTouched: [] });
    const last = h.emitted[h.emitted.length - 1];
    assert.equal(last.channel, "fleet:run:ended");
    assert.equal(last.payload.status, "failed");
    assert.equal(last.payload.error, "model 404");
    assert.deepEqual(last.payload.filesTouched, []);
    assert.equal(last.payload.toolCallCount, 0);
    assert.equal(last.payload.durationMs, 1500, "durationMs = endedAt - run:meta.startedAt");
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("journal phase events → fleet:phase:* in their own seq space; non-phase journal events stay internal", () => {
  const h = harness();
  try {
    h.journal.append("fl-d", { type: "run:started", runId: "fl-d", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
    h.journal.append("fl-d", { type: "phase:started", phase: "impl", ts: 2 });
    h.journal.append("fl-d", { type: "phase:completed", phase: "impl", summary: "did", paths: ["a.ts"], ts: 3 });
    h.journal.append("fl-d", { type: "phase:failed", phase: "review", error: "nits", ts: 4 });
    h.journal.append("fl-d", { type: "run:completed", runId: "fl-d", ts: 5 });
    const channels = h.emitted.map((e) => e.channel);
    assert.deepEqual(channels, ["fleet:phase:started", "fleet:phase:completed", "fleet:phase:failed"],
      "run:started/completed journal events are NOT published (run-level comes from RunLog)");
    assert.deepEqual(h.emitted[0].payload, { runId: "fl-d", seq: 1, ts: h.emitted[0].payload.ts, phase: "impl" });
    assert.deepEqual(
      { phase: h.emitted[1].payload.phase, summary: h.emitted[1].payload.summary, paths: h.emitted[1].payload.paths },
      { phase: "impl", summary: "did", paths: ["a.ts"] },
    );
    assert.deepEqual({ phase: h.emitted[2].payload.phase, error: h.emitted[2].payload.error }, { phase: "review", error: "nits" });
  } finally { h.bus.dispose(); rmSync(h.dir, { recursive: true, force: true }); }
});

test("dispose() stops all publication", () => {
  const h = harness();
  h.bus.dispose();
  h.runLog.append("fl-e", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
  h.journal.append("fl-e", { type: "phase:started", phase: "p", ts: 1 });
  assert.equal(h.emitted.length, 0);
  rmSync(h.dir, { recursive: true, force: true });
});

test("a throwing emit() never breaks the append path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bus-boom-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const journal = new RunJournal(join(dir, "runs"));
    const bus = new FleetEventBus({ runLog, journal, emit: () => { throw new Error("bus boom"); } });
    runLog.append("fl-f", { type: "message", role: "assistant", text: "x", turnIndex: 0 });
    assert.equal(runLog.replay("fl-f").length, 1, "event still persisted");
    bus.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/fleet-event-bus.test.mts` (timeout 60s)
Expected: FAIL — `Cannot find module '../src/rpc/event-bus.ts'`.

- [ ] **Step 3: Implement** — create `src/rpc/event-bus.ts`:

```typescript
// src/rpc/event-bus.ts
// SPEC-6-4 — FleetEventBus: translates RunLog/RunJournal appends into the public fleet:*
// taxonomy. THE FROZEN SURFACE LIVES HERE: channel names + envelope shapes are pinned by
// test/fleet-event-bus.test.mts — change them and every consumer breaks loudly.
//
// Seq spaces: one per source store (RunLog event order / journal event order), per run.
// Replay (RpcServer) reconstructs identical seqs by walking the same orders — consumers
// dedupe live-vs-replay by (channel, runId, seq).
import type { RunJournal, JournalEvent } from "../runtime/run-journal.ts";
import type { RunLog, RunLogEvent } from "../runtime/run-log.ts";

export type FleetChannel =
  | "fleet:run:started" | "fleet:run:ended"
  | "fleet:phase:started" | "fleet:phase:completed" | "fleet:phase:failed"
  | "fleet:child:message" | "fleet:child:tool";

export interface FleetEnvelope {
  runId: string;
  seq: number;
  /** Publish time (Date.now() at translation) — not the event's own timestamp. */
  ts: number;
  [key: string]: unknown;
}

export interface FleetEventBusDeps {
  runLog: Pick<RunLog, "subscribe">;
  journal: Pick<RunJournal, "subscribe">;
  /** Transport seam. In-process = (c, p) => pi.events.emit(c, p). A future external bridge
   *  re-implements ONLY this — the taxonomy above is its wire format. */
  emit: (channel: FleetChannel, payload: FleetEnvelope) => void;
}

interface MetaLike { startedAt: number }

export class FleetEventBus {
  private readonly runSeq = new Map<string, number>();
  private readonly phaseSeq = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly deps: FleetEventBusDeps) {
    this.unsubs.push(
      deps.runLog.subscribe((runId, event) => this.safe(() => this.onRunLogEvent(runId, event))),
      deps.journal.subscribe((runId, event) => this.safe(() => this.onJournalEvent(runId, event))),
    );
  }

  /** Unsubscribe from both stores. Call from session_shutdown. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /** A bus failure must never break a run's append path. */
  private safe(fn: () => void): void {
    try { fn(); } catch { /* swallow: telemetry must not kill the product */ }
  }

  private next(map: Map<string, number>, runId: string): number {
    const n = (map.get(runId) ?? 0) + 1;
    map.set(runId, n);
    return n;
  }

  private publish(channel: FleetChannel, runId: string, seq: number, payload: Record<string, unknown>): void {
    this.deps.emit(channel, { runId, seq, ts: Date.now(), ...payload });
  }

  private onRunLogEvent(runId: string, e: RunLogEvent): void {
    const seq = this.next(this.runSeq, runId);
    if (e.type === "run:meta") {
      this.startedAt.set(runId, e.startedAt);
      this.publish("fleet:run:started", runId, seq, {
        agent: e.agent, model: e.model, cwd: e.cwd, sessionCwd: e.sessionCwd,
        mode: e.mode ?? "foreground", task: e.task,
      });
    } else if (e.type === "message") {
      this.publish("fleet:child:message", runId, seq, { role: e.role, text: e.text });
    } else if (e.type === "tool") {
      this.publish("fleet:child:tool", runId, seq, { toolName: e.toolName, args: e.args, result: e.result, isError: e.isError });
    } else if (e.type === "run:ended") {
      const start = this.startedAt.get(runId);
      this.publish("fleet:run:ended", runId, seq, {
        status: e.status,
        ...(e.resultSummary !== undefined ? { result: e.resultSummary } : {}),
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.filesTouched !== undefined ? { filesTouched: e.filesTouched } : {}),
        ...(e.toolCallCount !== undefined ? { toolCallCount: e.toolCallCount } : {}),
        ...(start !== undefined ? { durationMs: e.endedAt - start } : {}),
      });
    }
  }

  private onJournalEvent(runId: string, e: JournalEvent): void {
    // Only the phase tier is public; run:started/completed/aborted/checkpoint/agent:*/helper:*
    // stay internal (run-level events come from RunLog, which every spawn writes).
    if (e.type === "phase:started") {
      this.publish("fleet:phase:started", runId, this.next(this.phaseSeq, runId), { phase: e.phase });
    } else if (e.type === "phase:completed") {
      this.publish("fleet:phase:completed", runId, this.next(this.phaseSeq, runId), { phase: e.phase, summary: e.summary, paths: e.paths });
    } else if (e.type === "phase:failed") {
      this.publish("fleet:phase:failed", runId, this.next(this.phaseSeq, runId), { phase: e.phase, error: e.error });
    }
  }
}
```

- [ ] **Step 4: Run gates**

Run: `npx tsx --test test/fleet-event-bus.test.mts` → PASS (6 tests).
Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/event-bus.ts test/fleet-event-bus.test.mts
git commit -m "feat: FleetEventBus — frozen fleet:* taxonomy on pi.events (SPEC-6-4 T3)"
```

---

### Task 4: `RpcServer` — verbs, gate, error codes

**Files:**
- Create: `src/rpc/rpc-server.ts`
- Test: `test/rpc-server.test.mts`

**Interfaces:**
- Consumes: Task 1 (`replay` already exists), `genRunId`/`RunRecord`/`LiveSessionHandle` (existing), `resolveDispatchCwd` (existing, `src/tools/subagent.ts`).
- Produces (frozen — pinned by this task's tests):

```typescript
export type RpcErrorCode =
  | "E-CONTROL-DISABLED" | "E-RUN-NOT-FOUND" | "E-RUN-FINISHED" | "E-BAD-VERB"
  | "E-BAD-PARAMS" | "E-STEER-UNSUPPORTED" | "E-INTERNAL";
export interface RpcRequest { id: string; verb: string; params?: unknown }
export type RpcReply = { id: string; ok: true; data: unknown } | { id: string; ok: false; error: { code: RpcErrorCode; message: string } };
export function rpcControlEnabled(env?: string): boolean;  // default ON; "0"/"false" (any case) → off
export interface RpcServerDeps {
  runRegistry: Pick<RunRegistry, "get" | "list">;
  runLog: Pick<RunLog, "replay">;
  journal: Pick<RunJournal, "replay">;
  parentCwd: string;
  hasAsyncRunner: boolean;
  /** Detached spawn: index wiring builds the real spawnSubagent invocation. Never throws;
   *  runtime failures land via registry/journal (spawnSubagent journals its own fail path). */
  spawn: (params: Record<string, unknown>, runId: string) => void;
}
export class RpcServer {
  constructor(deps: RpcServerDeps, controlEnabled?: () => boolean);
  handle(req: unknown): Promise<RpcReply | null>;  // null = malformed (no id) → caller drops
}
```

Verb semantics (spec §3.2 + amendments):
- `spawn` params: `{ agent, task, todoId?, track?, model?, skills?, cwd?, maxTurns?, background?, readOnly?, isolation? }`. `lifecycle`/`schedule`/`modelFallback` → `E-BAD-PARAMS` ("not supported over RPC spawn yet" — deferred, spec §7). Returns `{ runId }` immediately (pre-minted via `genRunId()`, passed to `deps.spawn`).
- `status` params `{ runId? }` → `{ runs: RpcRunSummary[] }` (single or list, newest-first, capped 25). Summary fields: `runId, agent, model, status, startedAt, endedAt?, task (≤80ch), cwd?, resultSummary?, tokenTotal?, sessionKey?`.
- `observe` params `{ runId, tier?: "lifecycle"|"child"|"both" }` → `{ runId, tier, events: [{ channel, payload }] }` — replay from `runLog.replay`/`journal.replay`, taxonomy-shaped, `payload.seq` reconstructing live seqs. Empty journals → `E-RUN-NOT-FOUND`.
- `steer` `{ runId, message }` → awaits `record.session.steer(message)`. No registry record → `E-RUN-NOT-FOUND`; no `session` → `E-RUN-FINISHED`; `!session.supportsSteer` → `E-STEER-UNSUPPORTED`; steer rejection containing "not supported" → `E-STEER-UNSUPPORTED`, other rejections → `E-INTERNAL`.
- `abort` `{ runId }` → awaits `record.session.abort()`. Same not-found/finished mapping; abort rejection containing "already" → `E-RUN-FINISHED`, else `E-INTERNAL`.
- Control verbs (`spawn`/`steer`/`abort`) when `rpcControlEnabled()` is false → `E-CONTROL-DISABLED` naming the env var. `observe`/`status` never gated.

- [ ] **Step 1: Write the failing test**

Create `test/rpc-server.test.mts`:

```typescript
// test/rpc-server.test.mts — SPEC-6-4 Task 4: RPC verbs, gate, error codes (frozen surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { RunRegistry, type RunRecord } from "../src/engine/run-registry.ts";
import { RpcServer, rpcControlEnabled } from "../src/rpc/rpc-server.ts";

function harness(over: Partial<ConstructorParameters<typeof RpcServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rpc-"));
  const runLog = new RunLog(join(dir, "conversations"));
  const journal = new RunJournal(join(dir, "runs"));
  const registry = new RunRegistry();
  let spawned: Array<{ params: Record<string, unknown>; runId: string }> = [];
  const deps = {
    runRegistry: registry, runLog, journal,
    parentCwd: dir, hasAsyncRunner: false,
    spawn: (params: Record<string, unknown>, runId: string) => { spawned.push({ params, runId }); },
    ...over,
  };
  const server = new RpcServer(deps, () => true);
  return { dir, runLog, journal, registry, server, deps, spawned: () => spawned };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "fl-x", agent: "scout", model: "Test/m", task: "t", track: false, todoId: null,
    status: "running", startedAt: 1, cwd: "/tmp", ...over,
  } as RunRecord;
}

test("rpcControlEnabled: default on, 0/false off (case-insensitive), anything else on", () => {
  assert.equal(rpcControlEnabled(undefined), true);
  assert.equal(rpcControlEnabled(""), true);
  assert.equal(rpcControlEnabled("1"), true);
  assert.equal(rpcControlEnabled("0"), false);
  assert.equal(rpcControlEnabled("FALSE"), false);
  assert.equal(rpcControlEnabled(" false "), false);
});

test("malformed requests (no id / not an object) → null (caller drops)", async () => {
  const h = harness();
  try {
    assert.equal(await h.server.handle(null), null);
    assert.equal(await h.server.handle("nope"), null);
    assert.equal(await h.server.handle({ verb: "status" }), null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("unknown verb → E-BAD-VERB; gate off → E-CONTROL-DISABLED on control verbs only", async () => {
  const h = harness();
  try {
    const bad = await h.server.handle({ id: "1", verb: "explode" });
    assert.equal((bad as { error: { code: string } }).error.code, "E-BAD-VERB");
    const gated = new RpcServer(h.deps, () => false);
    const r1 = await gated.handle({ id: "2", verb: "spawn", params: { agent: "a", task: "t" } });
    assert.equal((r1 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r2 = await gated.handle({ id: "3", verb: "steer", params: { runId: "fl-x", message: "m" } });
    assert.equal((r2 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r3 = await gated.handle({ id: "4", verb: "abort", params: { runId: "fl-x" } });
    assert.equal((r3 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r4 = await gated.handle({ id: "5", verb: "status", params: {} });
    assert.equal((r4 as { ok: boolean }).ok, true, "read-only status is never gated");
    const r5 = await gated.handle({ id: "6", verb: "observe", params: { runId: "fl-x" } });
    assert.equal((r5 as { ok: boolean }).ok, true, "read-only observe is never gated");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("spawn: validates params, pre-mints runId, calls the detached spawn, returns { runId }", async () => {
  const h = harness();
  try {
    const r = await h.server.handle({ id: "s1", verb: "spawn", params: { agent: "scout", task: "go" } }) as { ok: true; data: { runId: string } };
    assert.equal(r.ok, true);
    assert.match(r.data.runId, /^fl-/);
    assert.equal(h.spawned().length, 1);
    assert.equal(h.spawned()[0].runId, r.data.runId, "the pre-minted runId is handed to the spawn");
    assert.equal(h.spawned()[0].params.agent, "scout");
    const bad = await h.server.handle({ id: "s2", verb: "spawn", params: { agent: "", task: "go" } });
    assert.equal((bad as { error: { code: string } }).error.code, "E-BAD-PARAMS");
    const life = await h.server.handle({ id: "s3", verb: "spawn", params: { agent: "a", task: "t", lifecycle: "default" } });
    assert.equal((life as { error: { code: string } }).error.code, "E-BAD-PARAMS", "lifecycle over RPC is deferred (spec §7)");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("spawn: invalid cwd → E-BAD-PARAMS before minting (no ghost runId)", async () => {
  const h = harness();
  try {
    const r = await h.server.handle({ id: "c1", verb: "spawn", params: { agent: "a", task: "t", cwd: "/does/not/exist" } });
    assert.equal((r as { error: { code: string } }).error.code, "E-BAD-PARAMS");
    assert.equal(h.spawned().length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("status: single run + list (newest-first, capped) with the summary shape", async () => {
  const h = harness();
  try {
    h.deps.runRegistry.add(record({ runId: "fl-old", startedAt: 1, status: "completed", endedAt: 2, resultSummary: "done", tokenTotal: 5 }));
    h.deps.runRegistry.add(record({ runId: "fl-new", startedAt: 9, cwd: "/w" }));
    const one = await h.server.handle({ id: "q1", verb: "status", params: { runId: "fl-new" } }) as { ok: true; data: { runs: Array<Record<string, unknown>> } };
    assert.equal(one.data.runs.length, 1);
    assert.deepEqual(
      { runId: one.data.runs[0].runId, status: one.data.runs[0].status, cwd: one.data.runs[0].cwd },
      { runId: "fl-new", status: "running", cwd: "/w" },
    );
    const all = await h.server.handle({ id: "q2", verb: "status", params: {} }) as { ok: true; data: { runs: Array<Record<string, unknown>> } };
    assert.deepEqual(all.data.runs.map((r) => r.runId), ["fl-new", "fl-old"], "newest-first");
    const missing = await h.server.handle({ id: "q3", verb: "status", params: { runId: "fl-nope" } });
    assert.equal((missing as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("observe: replay shapes match live taxonomy and seqs reconstruct from append order", async () => {
  const h = harness();
  try {
    h.runLog.append("fl-r", { type: "run:meta", runId: "fl-r", agent: "scout", model: "m", task: "t", startedAt: 1, track: false, todoId: null });
    h.runLog.append("fl-r", { type: "message", role: "assistant", text: "one", turnIndex: 0 });
    h.runLog.append("fl-r", { type: "tool", toolName: "read", args: "a.ts", result: "body", isError: false, turnIndex: 0 });
    h.runLog.append("fl-r", { type: "run:ended", runId: "fl-r", status: "completed", endedAt: 9, tokenTotal: 3 });
    const child = await h.server.handle({ id: "o1", verb: "observe", params: { runId: "fl-r", tier: "child" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.deepEqual(child.data.events.map((e) => e.channel), ["fleet:child:message", "fleet:child:tool"]);
    assert.deepEqual(child.data.events.map((e) => e.payload.seq), [1, 2], "seq reconstructs from RunLog append order");
    const life = await h.server.handle({ id: "o2", verb: "observe", params: { runId: "fl-r", tier: "lifecycle" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.deepEqual(life.data.events.map((e) => e.channel), ["fleet:run:started", "fleet:run:ended"]);
    assert.equal(life.data.events[1].payload.status, "completed");
    const nf = await h.server.handle({ id: "o3", verb: "observe", params: { runId: "fl-absent" } });
    assert.equal((nf as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("steer/abort: session-handle mapping (not-found / finished / unsupported / ok)", async () => {
  const h = harness();
  try {
    const steered: string[] = [];
    const aborted: string[] = [];
    h.deps.runRegistry.add(record({ runId: "fl-live", session: {
      steer: async (t: string) => { steered.push(t); },
      abort: async () => { aborted.push("x"); },
      get supportsSteer() { return true; },
    } as never }));
    h.deps.runRegistry.add(record({ runId: "fl-claude", session: {
      steer: async () => { throw new Error("steer not supported on this backend"); },
      abort: async () => {},
      get supportsSteer() { return false; },
    } as never }));
    h.deps.runRegistry.add(record({ runId: "fl-done", status: "completed", endedAt: 2 }));

    const nf = await h.server.handle({ id: "g1", verb: "steer", params: { runId: "fl-absent", message: "m" } });
    assert.equal((nf as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
    const fin = await h.server.handle({ id: "g2", verb: "abort", params: { runId: "fl-done" } });
    assert.equal((fin as { error: { code: string } }).error.code, "E-RUN-FINISHED");
    const unsup = await h.server.handle({ id: "g3", verb: "steer", params: { runId: "fl-claude", message: "m" } });
    assert.equal((unsup as { error: { code: string } }).error.code, "E-STEER-UNSUPPORTED");
    const okSteer = await h.server.handle({ id: "g4", verb: "steer", params: { runId: "fl-live", message: "pivot" } });
    assert.equal((okSteer as { ok: boolean }).ok, true);
    assert.deepEqual(steered, ["pivot"], "steer reached the live handle");
    const okAbort = await h.server.handle({ id: "g5", verb: "abort", params: { runId: "fl-live" } });
    assert.equal((okAbort as { ok: boolean }).ok, true);
    assert.deepEqual(aborted, ["x"], "abort reached the live handle");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a handler exception → E-INTERNAL, never a thrown reply (one reply per request)", async () => {
  const h = harness();
  try {
    const throwing = new RpcServer({
      ...h.deps,
      runRegistry: { get: () => { throw new Error("boom"); }, list: () => [] },
    } as never, () => true);
    const r = await throwing.handle({ id: "z1", verb: "status", params: { runId: "fl-x" } });
    assert.equal((r as { error: { code: string } }).error.code, "E-INTERNAL");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/rpc-server.test.mts` (timeout 60s)
Expected: FAIL — `Cannot find module '../src/rpc/rpc-server.ts'`.

- [ ] **Step 3: Implement** — create `src/rpc/rpc-server.ts`:

```typescript
// src/rpc/rpc-server.ts
// SPEC-6-4 — the fleet:rpc verb surface. Frozen: verb names, param contracts, reply envelope
// { id, ok, data | error{code,message} }, and the error-code enum — all pinned by
// test/rpc-server.test.mts. handle() NEVER throws and replies EXACTLY once per request.
import { genRunId } from "../engine/run-registry.ts";
import type { RunRegistry, RunRecord } from "../engine/run-registry.ts";
import type { RunLog } from "../runtime/run-log.ts";
import type { RunJournal } from "../runtime/run-journal.ts";
import { resolveDispatchCwd } from "../tools/subagent.ts";

export type RpcErrorCode =
  | "E-CONTROL-DISABLED" | "E-RUN-NOT-FOUND" | "E-RUN-FINISHED" | "E-BAD-VERB"
  | "E-BAD-PARAMS" | "E-STEER-UNSUPPORTED" | "E-INTERNAL";

export interface RpcRequest { id: string; verb: string; params?: unknown }
export type RpcReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: RpcErrorCode; message: string } };

/** SPEC-6-4 gate: ON unless ARMORY_FLEET_RPC_CONTROL is "0"/"false" (case-insensitive).
 *  Read-only verbs (observe/status) ignore this. Honest threat model: in-process extensions
 *  already have full system access via pi itself — the gate guards accidents, not adversaries. */
export function rpcControlEnabled(env: string | undefined = process.env.ARMORY_FLEET_RPC_CONTROL): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false");
}

export interface RpcRunSummary {
  runId: string; agent: string; model: string; status: string; startedAt: number;
  endedAt?: number; task: string; cwd?: string; resultSummary?: string; tokenTotal?: number; sessionKey?: string;
}

export interface RpcServerDeps {
  runRegistry: Pick<RunRegistry, "get" | "list">;
  runLog: Pick<RunLog, "replay">;
  journal: Pick<RunJournal, "replay">;
  parentCwd: string;
  hasAsyncRunner: boolean;
  /** Detached spawn: index.ts builds the real spawnSubagent invocation (foreground or bg routing).
   *  Never throws — runtime failures land via the registry + RunLog journal (spawnSubagent's own
   *  fail path journals run:ended), so the caller's { runId } always resolves to a real run. */
  spawn: (params: Record<string, unknown>, runId: string) => void;
}

const LIST_CAP = 25;
const TASK_SUMMARY_CAP = 80;

function summarize(r: RunRecord): RpcRunSummary {
  const task = r.task.length > TASK_SUMMARY_CAP ? r.task.slice(0, TASK_SUMMARY_CAP - 1) + "…" : r.task;
  return {
    runId: r.runId, agent: r.agent, model: r.model, status: r.status, startedAt: r.startedAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    task, ...(r.cwd ? { cwd: r.cwd } : {}),
    ...(r.resultSummary !== undefined ? { resultSummary: r.resultSummary } : {}),
    ...(r.tokenTotal !== undefined ? { tokenTotal: r.tokenTotal } : {}),
    ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}),
  };
}

export class RpcServer {
  constructor(
    private readonly deps: RpcServerDeps,
    private readonly controlEnabled: () => boolean = rpcControlEnabled,
  ) {}

  /** Returns the reply, or null for a malformed request with no usable id (caller drops).
   *  Never throws — a handler exception becomes E-INTERNAL. */
  async handle(req: unknown): Promise<RpcReply | null> {
    const id = requestId(req);
    try {
      return await this.dispatch(req, id);
    } catch (e) {
      if (!id) return null;
      return { id, ok: false, error: { code: "E-INTERNAL", message: `unexpected rpc failure: ${(e as Error).message}` } };
    }
  }

  private async dispatch(req: unknown, id: string | null): Promise<RpcReply | null> {
    if (!req || typeof req !== "object" || !id) return null;
    const { verb, params } = req as Record<string, unknown>;
    if (typeof verb !== "string") return this.err(id, "E-BAD-VERB", "missing verb");
    const gated = this.controlEnabled();
    switch (verb) {
      case "spawn": return gated ? this.spawnVerb(id, params) : this.controlDisabled(id);
      case "steer": return gated ? this.steerVerb(id, params) : this.controlDisabled(id);
      case "abort": return gated ? this.abortVerb(id, params) : this.controlDisabled(id);
      case "observe": return this.observeVerb(id, params);
      case "status": return this.statusVerb(id, params);
      default: return this.err(id, "E-BAD-VERB", `unknown verb '${verb}' (known: spawn, steer, observe, abort, status)`);
    }
  }

  private controlDisabled(id: string): RpcReply {
    return this.err(id, "E-CONTROL-DISABLED", "fleet rpc control is disabled (ARMORY_FLEET_RPC_CONTROL is set to off; remove it or set it to 1 to enable spawn/steer/abort)");
  }

  private err(id: string, code: RpcErrorCode, message: string): RpcReply {
    return { id, ok: false, error: { code, message } };
  }

  private obj(params: unknown): Record<string, unknown> | null {
    return params && typeof params === "object" ? params as Record<string, unknown> : null;
  }

  private spawnVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "spawn requires params: { agent, task, ... }");
    if (typeof p.agent !== "string" || !p.agent) return this.err(id, "E-BAD-PARAMS", "params.agent must be a non-empty string");
    if (typeof p.task !== "string" || !p.task) return this.err(id, "E-BAD-PARAMS", "params.task must be a non-empty string");
    if (p.lifecycle !== undefined) return this.err(id, "E-BAD-PARAMS", "params.lifecycle is not supported over RPC spawn yet (single-delegate + background only — spec §7)");
    if (p.schedule !== undefined) return this.err(id, "E-BAD-PARAMS", "params.schedule is not supported over RPC spawn yet");
    if (p.modelFallback !== undefined) return this.err(id, "E-BAD-PARAMS", "params.modelFallback is not supported over RPC spawn yet");
    if (p.cwd !== undefined && (typeof p.cwd !== "string" || p.cwd === "")) return this.err(id, "E-BAD-PARAMS", "params.cwd must be a non-empty string when set");
    if (p.cwd !== undefined) {
      const { error } = resolveDispatchCwd(p.cwd, this.deps.parentCwd);
      if (error) return this.err(id, "E-BAD-PARAMS", error);
    }
    if (p.background !== undefined && typeof p.background !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.background must be a boolean");
    if (p.background && !this.deps.hasAsyncRunner) return this.err(id, "E-BAD-PARAMS", "background runs not configured in this session (asyncRunner missing)");
    if (p.isolation !== undefined && p.isolation !== "worktree" && p.isolation !== "none" && p.isolation !== "auto") {
      return this.err(id, "E-BAD-PARAMS", "params.isolation must be 'worktree' | 'none' | 'auto'");
    }
    if (p.maxTurns !== undefined && (typeof p.maxTurns !== "number" || !Number.isInteger(p.maxTurns) || p.maxTurns < 1)) {
      return this.err(id, "E-BAD-PARAMS", "params.maxTurns must be a positive integer");
    }
    if (p.readOnly !== undefined && typeof p.readOnly !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.readOnly must be a boolean");
    if (p.track !== undefined && typeof p.track !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.track must be a boolean");
    if (p.todoId !== undefined && typeof p.todoId !== "string") return this.err(id, "E-BAD-PARAMS", "params.todoId must be a string");
    if (p.model !== undefined && (typeof p.model !== "string" || !p.model)) return this.err(id, "E-BAD-PARAMS", "params.model must be a non-empty string when set");
    if (p.skills !== undefined && (!Array.isArray(p.skills) || !p.skills.every((s) => typeof s === "string"))) {
      return this.err(id, "E-BAD-PARAMS", "params.skills must be an array of strings");
    }
    const runId = genRunId();
    this.deps.spawn(p, runId);
    return { id, ok: true, data: { runId } };
  }

  private statusVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params) ?? {};
    if (p.runId !== undefined) {
      if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
      const rec = this.deps.runRegistry.get(p.runId);
      if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry (finished runs older than the session are not listed)`);
      return { id, ok: true, data: { runs: [summarize(rec)] } };
    }
    const runs = this.deps.runRegistry.list().slice(0, LIST_CAP).map(summarize);
    return { id, ok: true, data: { runs } };
  }

  private observeVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "observe requires params: { runId, tier? }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    const tier = p.tier ?? "both";
    if (tier !== "lifecycle" && tier !== "child" && tier !== "both") {
      return this.err(id, "E-BAD-PARAMS", "params.tier must be 'lifecycle' | 'child' | 'both'");
    }
    const logEvents = this.deps.runLog.replay(p.runId);
    const journalEvents = this.deps.journal.replay(p.runId);
    if (logEvents.length === 0 && journalEvents.length === 0) {
      return this.err(id, "E-RUN-NOT-FOUND", `no journaled run '${p.runId}'`);
    }
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    if (tier === "lifecycle" || tier === "both") {
      let seq = 0;
      for (const e of logEvents) {
        if (e.type === "run:meta") {
          events.push({ channel: "fleet:run:started", payload: { seq: ++seq, agent: e.agent, model: e.model, cwd: e.cwd, sessionCwd: e.sessionCwd, mode: e.mode ?? "foreground", task: e.task, ts: e.startedAt } });
        } else if (e.type === "run:ended") {
          events.push({
            channel: "fleet:run:ended",
            payload: { seq: ++seq, status: e.status, ts: e.endedAt,
              ...(e.resultSummary !== undefined ? { result: e.resultSummary } : {}),
              ...(e.error !== undefined ? { error: e.error } : {}),
              ...(e.filesTouched !== undefined ? { filesTouched: e.filesTouched } : {}),
              ...(e.toolCallCount !== undefined ? { toolCallCount: e.toolCallCount } : {}) },
          });
        }
      }
      let pseq = 0;
      for (const e of journalEvents) {
        if (e.type === "phase:started") events.push({ channel: "fleet:phase:started", payload: { seq: ++pseq, phase: e.phase, ts: e.ts } });
        else if (e.type === "phase:completed") events.push({ channel: "fleet:phase:completed", payload: { seq: ++pseq, phase: e.phase, summary: e.summary, paths: e.paths, ts: e.ts } });
        else if (e.type === "phase:failed") events.push({ channel: "fleet:phase:failed", payload: { seq: ++pseq, phase: e.phase, error: e.error, ts: e.ts } });
      }
    }
    if (tier === "child" || tier === "both") {
      let seq = 0;
      for (const e of logEvents) {
        if (e.type === "message") events.push({ channel: "fleet:child:message", payload: { seq: ++seq, role: e.role, text: e.text } });
        else if (e.type === "tool") events.push({ channel: "fleet:child:tool", payload: { seq: ++seq, toolName: e.toolName, args: e.args, result: e.result, isError: e.isError } });
      }
    }
    return { id, ok: true, data: { runId: p.runId, tier, events } };
  }

  private async steerVerb(id: string, params: unknown): Promise<RpcReply> {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "steer requires params: { runId, message }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    if (typeof p.message !== "string" || !p.message) return this.err(id, "E-BAD-PARAMS", "params.message must be a non-empty string");
    const rec = this.deps.runRegistry.get(p.runId);
    if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry`);
    const session = rec.session;
    if (!session) return this.err(id, "E-RUN-FINISHED", `run '${p.runId}' has no live session (status: ${rec.status})`);
    if (!session.supportsSteer) return this.err(id, "E-STEER-UNSUPPORTED", `run '${p.runId}' backend has no steer support (claude children)`);
    try {
      await session.steer(p.message);
    } catch (e) {
      const msg = (e as Error).message ?? "steer failed";
      if (msg.includes("not supported")) return this.err(id, "E-STEER-UNSUPPORTED", msg);
      return this.err(id, "E-INTERNAL", `steer failed: ${msg}`);
    }
    return { id, ok: true, data: { steered: true } };
  }

  private async abortVerb(id: string, params: unknown): Promise<RpcReply> {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "abort requires params: { runId }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    const rec = this.deps.runRegistry.get(p.runId);
    if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry`);
    const session = rec.session;
    if (!session) return this.err(id, "E-RUN-FINISHED", `run '${p.runId}' has no live session (status: ${rec.status})`);
    try {
      await session.abort();
    } catch (e) {
      const msg = (e as Error).message ?? "abort failed";
      if (msg.includes("already")) return this.err(id, "E-RUN-FINISHED", msg);
      return this.err(id, "E-INTERNAL", `abort failed: ${msg}`);
    }
    return { id, ok: true, data: { aborted: true } };
  }
}

function requestId(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const id = (req as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}
```

NOTE for the implementer: `RunRecord.session` is typed `LiveSessionHandle` — check `src/engine/spawnSubagent.ts:72` for the exact interface (`steer`, `abort`, `supportsSteer` getter). If `supportsSteer` is only on the `toLiveHandle()` wrapper object (not the interface), widen nothing: read it defensively as `(session as { supportsSteer?: boolean }).supportsSteer !== false` and adjust the test's fake handles to match. Run typecheck and reconcile with the REAL types — never `as never` your way past a genuine mismatch in production code (test fixtures may cast).

- [ ] **Step 4: Run gates**

Run: `npx tsx --test test/rpc-server.test.mts` → PASS (9 tests).
Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/rpc-server.ts test/rpc-server.test.mts
git commit -m "feat: RpcServer — spawn/steer/observe/abort/status over fleet:rpc (SPEC-6-4 T4)"
```

---

### Task 5: index.ts wiring — bus + server + detached spawn + disposal

**Files:**
- Modify: `src/index.ts` (session_start wiring ~line 357-400; session_shutdown ~line 503)

**Interfaces:**
- Consumes: Task 2 (`spawnSubagent` opts), Task 3 (`FleetEventBus`), Task 4 (`RpcServer`).
- Produces (runtime wiring, no exported API): on `session_start`, a `FleetEventBus` publishes to `pi.events`; an `RpcServer` answers `fleet:rpc` and replies on `fleet:rpc:result`. Both are disposed on `session_shutdown`.

- [ ] **Step 1: Hoist the journal instance**

At `session_start` (~line 357), the journal is currently created inline inside the asyncRunnerDeps object literal (~line 381: `journal: new RunJournal(join(dir, "runs"))`). Hoist it above so the bus and the runner share ONE instance:

```typescript
    // SPEC-6-4: one shared RunJournal instance — the FleetEventBus subscribes to it, so the
    // runner and the bus must see the same object (two instances = bus-blind phase events).
    const fleetJournal = new RunJournal(join(dir, "runs"));
```

and use `journal: fleetJournal,` in the asyncRunnerDeps literal. Check the workflow journal wiring (~lines 466-483 use `workflowJournal`): if `workflowJournal` is a DIFFERENT `RunJournal` instance, replace it with `fleetJournal` too (same dir, one instance — the phase tier must see workflow runs as well). Verify with `rg -n "new RunJournal" src/index.ts` — exactly one construction site should remain.

- [ ] **Step 2: Wire the bus + server (still inside session_start, after `deps.runLog` is set ~line 361)**

```typescript
    // SPEC-6-4: public surface — FleetEventBus publishes the fleet:* taxonomy on pi.events;
    // RpcServer answers fleet:rpc requests. Transport = pi.events (in-process). A future
    // external bridge replaces ONLY FleetEventBusDeps.emit + this listener (spec §7).
    deps.fleetBus = new FleetEventBus({
      runLog: deps.runLog,
      journal: fleetJournal,
      emit: (channel, payload) => pi.events.emit(channel, payload),
    });
    const rpcServer = new RpcServer(
      {
        runRegistry: deps.runRegistry,
        runLog: deps.runLog,
        journal: fleetJournal,
        parentCwd: ctx.cwd,
        hasAsyncRunner: true,
        spawn: (p, runId) => {
          // Detached dispatch — the RPC caller already holds the pre-minted runId. Mirrors the
          // tool's direct foreground invocation (src/tools/subagent.ts) minus the await: no
          // modelFallback retry over RPC yet (spec §7). Runtime failures land via registry+journal.
          const input = p as {
            background?: boolean; cwd?: string; isolation?: "worktree" | "none" | "auto";
          };
          const { cwd: resolvedCwd } = resolveDispatchCwd(input.cwd, ctx.cwd);
          if (input.background) {
            const handle = runBackground(String(p.task), {
              deps: deps.asyncRunner!, lifecycle: "default", mode: "auto",
              isolation: input.isolation, cwd: resolvedCwd,
            });
            if (handle.status === "failed") {
              deps.runLog?.append(runId, { type: "run:ended", runId, status: "failed", endedAt: Date.now(), tokenTotal: 0, error: handle.error });
            }
            return;
          }
          void spawnSubagent({
            agent: String(p.agent), task: String(p.task),
            ...(p.todoId !== undefined ? { todoId: p.todoId as string } : {}),
            ...(p.track !== undefined ? { track: p.track as boolean } : {}),
            ...(p.model !== undefined ? { model: p.model as string } : {}),
            ...(p.skills !== undefined ? { skillsOverride: p.skills as string[] } : {}),
            ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
            ...(p.readOnly === true ? { readOnly: true } : {}),
            runId,
            registry: deps.registry, todoSync: deps.todoSync, runRegistry: deps.runRegistry, lock: deps.lock,
            backendRegistry: deps.backendRegistry, parentModel: deps.parentModel, parentCwd: ctx.cwd,
            runLog: deps.runLog, tierRegistry: deps.tierRegistry, modelRegistry: deps.modelRegistry,
            cwd: resolvedCwd,
          } as never).catch(() => { /* spawnSubagent journals its own failures; never reject unhandled */ });
        },
      },
      () => rpcControlEnabled(),
    );
    deps.rpcUnsub = pi.events.on("fleet:rpc", (data: unknown) => {
      void rpcServer.handle(data).then((reply) => { if (reply) pi.events.emit("fleet:rpc:result", reply); });
    });
```

Notes for the implementer:
- `resolveDispatchCwd` is already imported by index.ts? Check the imports at the top; if absent, add `import { resolveDispatchCwd } from "./tools/subagent.ts";` (it's exported there). `runBackground`, `spawnSubagent`, `FleetEventBus`, `RpcServer`, `rpcControlEnabled` likewise.
- The exact `spawnSubagent` opts here mirror `src/tools/subagent.ts`'s direct-foreground call (~line 145) — copy the field set from THERE and add `runId`; if the tool's call has fields this listing lacks (e.g. new deps since writing), match the tool.
- `deps.asyncRunner!` — by spawn time it is constructed (same session_start block); keep the non-null assertion local with a comment.

- [ ] **Step 3: Extend `deps` + dispose in session_shutdown**

The deps object (the module-level `const deps = { ... }` ~line 230+ or wherever it's declared) gains:

```typescript
  fleetBus?: import("./rpc/event-bus.ts").FleetEventBus;
  rpcUnsub?: () => void;
```

In `session_shutdown` (~line 503, where `deps.runLog = undefined as RunLog | undefined;` already sits), add BEFORE the existing resets:

```typescript
    // SPEC-6-4: release the public surface (unsubscribe bus + rpc listener) — no zombie
    // subscriptions into the next session.
    deps.fleetBus?.dispose();
    deps.fleetBus = undefined;
    deps.rpcUnsub?.();
    deps.rpcUnsub = undefined;
```

- [ ] **Step 4: Run gates**

Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass (wiring has no new unit tests; the smoke round-trip in Task 7 covers the seam end-to-end).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire FleetEventBus + RpcServer into the session lifecycle (SPEC-6-4 T5)"
```

---

### Task 6: Live viewer — timeline overlay live mode

**Files:**
- Create: `src/panel/live-timeline.ts`
- Modify: `src/panel/fleet-panel.ts` (timeline-open site ~line 649, overlay key forwarding ~line 551, overlay close ~line 327)
- Test: `test/live-timeline.test.mts`

**Interfaces:**
- Consumes: Task 1 (`RunLog.subscribe`), existing panel deps (`deps.runLog`).
- Produces: `LiveTimelineState` — pure tail-follow state:

```typescript
export class LiveTimelineState {
  index: number;   // 0-based cursor into the RENDERED (message/tool-filtered) list
  pinned: boolean; // true while riding the newest row
  constructor();
  onKey(key: "up" | "down", total: number): boolean; // move cursor; returns true when the view must re-render
  append(total: number): number;                     // new event arrived; returns the cursor to restore
}
```

Panel behavior (spec §3.4): opening the timeline overlay on a RUNNING run enters live mode — hydrate via `runLog.replay(runId)` (already the open behavior), then subscribe to `runLog.subscribe`, filter `(runId === selectedRun.runId && (event.type === "message" || event.type === "tool"))`, push onto `runTimeline`, re-render with the cursor pinned to the newest row while `pinned`. In live mode the panel OWNS the up/down cursor (intercepts before forwarding to the `SelectList`); finished-run overlays behave exactly as today (forwarded keys, no subscription).

- [ ] **Step 1: Write the failing test**

Create `test/live-timeline.test.mts`:

```typescript
// test/live-timeline.test.mts — SPEC-6-4 Task 6: tail-follow state machine (pure logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveTimelineState } from "../src/panel/live-timeline.ts";

test("starts pinned at index 0", () => {
  const s = new LiveTimelineState();
  assert.equal(s.index, 0);
  assert.equal(s.pinned, true);
});

test("append keeps the cursor on the newest row while pinned", () => {
  const s = new LiveTimelineState();
  s.onKey("down", 1);          // index 0 → pinned (only row)
  assert.equal(s.append(2), 1, "cursor rides to the new last row");
  assert.equal(s.append(3), 2);
});

test("up unpins; append then leaves the cursor alone", () => {
  const s = new LiveTimelineState();
  s.append(3);                 // pinned at 2
  assert.equal(s.onKey("up", 3), true);
  assert.equal(s.index, 1);
  assert.equal(s.pinned, false);
  assert.equal(s.append(4), 1, "unpinned cursor does not move");
});

test("down re-pins only at the last row", () => {
  const s = new LiveTimelineState();
  s.append(4);                 // pinned at 3
  s.onKey("up", 4);            // 2, unpinned
  assert.equal(s.onKey("down", 4), true);
  assert.equal(s.index, 2);
  assert.equal(s.pinned, false, "mid-list down is not pinned");
  assert.equal(s.onKey("down", 4), true);
  assert.equal(s.index, 3);
  assert.equal(s.pinned, true, "reaching the last row re-pins");
  assert.equal(s.append(5), 4, "pinned again — rides new rows");
});

test("cursor never leaves [0, total-1]", () => {
  const s = new LiveTimelineState();
  assert.equal(s.onKey("up", 1), false, "up at top is a no-op");
  s.append(2);
  assert.equal(s.onKey("down", 2), false, "down at bottom is a no-op");
});

test("empty list: keys are no-ops", () => {
  const s = new LiveTimelineState();
  assert.equal(s.onKey("up", 0), false);
  assert.equal(s.onKey("down", 0), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/live-timeline.test.mts` (timeout 60s)
Expected: FAIL — `Cannot find module '../src/panel/live-timeline.ts'`.

- [ ] **Step 3: Implement** — create `src/panel/live-timeline.ts`:

```typescript
// src/panel/live-timeline.ts
// SPEC-6-4 — tail-follow state for the live timeline overlay. Pure logic (unit-tested);
// the panel owns the SelectList and consults this on forwarded keys + live appends.
export class LiveTimelineState {
  /** 0-based cursor into the RENDERED (message/tool-filtered) event list. */
  index = 0;
  /** True while the cursor rides the newest row (live appends move the view). */
  pinned = true;

  /** Handle a forwarded scroll key. Returns true when the view must re-render. */
  onKey(key: "up" | "down", total: number): boolean {
    if (total === 0) return false;
    if (key === "up") {
      if (this.index <= 0) return false;
      this.index--;
      this.pinned = false;
      return true;
    }
    // down
    if (this.index >= total - 1) return false;
    this.index++;
    this.pinned = this.index === total - 1;
    return true;
  }

  /** A new event arrived (list now has `total` rendered rows). Returns the cursor to restore:
   *  the newest row while pinned, unchanged otherwise. */
  append(total: number): number {
    if (this.pinned) this.index = total - 1;
    return this.index;
  }
}
```

- [ ] **Step 4: Wire the panel**

In `src/panel/fleet-panel.ts`:

1. Add state fields next to the 5b-1 overlay state (~line 112):

```typescript
  // SPEC-6-4: live mode for the timeline overlay (running runs stream; finished runs replay).
  private liveUnsub: (() => void) | null = null;
  private liveState: LiveTimelineState | null = null;
```

(import `LiveTimelineState` from `./live-timeline.ts`.)

2. At the timeline-open site (~line 649, where `this.runTimeline = this.deps.runLog.replay(sel.value);`), after hydration decide the mode:

```typescript
          this.runTimeline = this.deps.runLog.replay(sel.value);
          // SPEC-6-4: live mode when the run is still running — subscribe to appends; replay otherwise.
          this.liveUnsub?.(); this.liveUnsub = null; this.liveState = null;
          const meta = this.deps.runLog?.scanMeta().find((m) => m.runId === sel.value);
          if (meta?.status === "running" && this.deps.runLog) {
            this.liveState = new LiveTimelineState();
            const renderedCount = () => (this.runTimeline ?? []).filter((e) => e.type === "message" || e.type === "tool").length;
            this.liveState.index = Math.max(0, renderedCount() - 1);
            this.liveUnsub = this.deps.runLog.subscribe((runId, ev) => {
              if (runId !== this.selectedRun?.runId) return;
              if (ev.type !== "message" && ev.type !== "tool") return;
              this.runTimeline = [...(this.runTimeline ?? []), ev];
              if (!this.liveState) return;
              const idx = this.liveState.append(renderedCount());
              this.selectedEventIndex = idx;   // one-shot cursor-restore token consumed by renderShell
              this.renderShell();
            });
          }
```

(If the runs-list open site at ~line 516 shares this code path, apply the same block there or extract a private `openRunTimeline(runId: string)` method used by both — prefer the extraction if the two sites are duplicated.)

3. In `handleInput`'s timeline-overlay branch (~line 551, where keys are forwarded to `this.timelineList`): when live, OWN the vertical keys first:

```typescript
        // SPEC-6-4: in live mode the panel owns the cursor (tail-follow) — intercept up/down
        // before the SelectList forward; everything else forwards as before.
        if (this.liveState && (matchesKey(data, "up") || matchesKey(data, "down"))) {
          const total = (this.runTimeline ?? []).filter((e) => e.type === "message" || e.type === "tool").length;
          const key = matchesKey(data, "up") ? "up" as const : "down" as const;
          if (this.liveState.onKey(key, total)) {
            this.selectedEventIndex = this.liveState.index;
            this.renderShell();
          }
          return;
        }
```

(Copy the exact key-matching idiom from the surrounding forward code — `matchesKey(data, "up")` per the file's existing usage; adapt if the branch uses a different matcher.)

4. Release on close: in the timeline `onCancel` (~line 327) add `this.liveUnsub?.(); this.liveUnsub = null; this.liveState = null;`. Also add the same three lines where the panel closes its other subscriptions (the `closed`/cleanup path that drains `this.unsubs` — push a permanent cleanup there too: `if (this.liveUnsub) this.unsubs.push(this.liveUnsub)` at field-init time is wrong since it changes; instead include the trio in the panel's close method).

- [ ] **Step 5: Run gates**

Run: `npx tsx --test test/live-timeline.test.mts` → PASS (6 tests).
Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass (panel tests must stay green — the non-live path is untouched).

- [ ] **Step 6: Manual smoke in real pi (the EditorTheme-gotcha rule: panel work gets a real-TUI look)**

Run: `pi --no-extensions -e ./src/index.ts --no-session --approve` in a scratch repo, dispatch a trivial background subagent (`subagent({ task: "say hi", background: true })` via the model or `/fleet` Run action), open `/fleet` → Runs → the running row → timeline: rows appear as the child produces them; up-scroll unpins; down to bottom re-pins. Escape closes cleanly (no leaked subscription — reopen shows replay).

- [ ] **Step 7: Commit**

```bash
git add src/panel/live-timeline.ts src/panel/fleet-panel.ts test/live-timeline.test.mts
git commit -m "feat: live timeline overlay — tail-follow streaming for running runs (SPEC-6-4 T6)"
```

---

### Task 7: README + client helper + release-gate smoke round-trip

**Files:**
- Modify: `README.md` (new "Event bus + RPC (v1.0)" section near the other feature sections)
- Modify: `test/smoke.test.mts` (add the RPC round-trip)

**Interfaces:**
- Consumes: Tasks 3-5 (the real modules end-to-end).
- Produces: docs + the release-gate seam.

- [ ] **Step 1: Add the smoke round-trip**

Append to `test/smoke.test.mts` (imports: `mkdtempSync/rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, plus `RunLog`, `RunJournal`, `RunRegistry`, `FleetEventBus`, `RpcServer`):

```typescript
test("SPEC-6-4 release-gate: fleet rpc round-trip — bus publish + status/observe over real journals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rpc-smoke-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const journal = new RunJournal(join(dir, "runs"));
    const registry = new RunRegistry();
    const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const bus = new FleetEventBus({ runLog, journal, emit: (channel, payload) => emitted.push({ channel, payload: payload as Record<string, unknown> }) });
    const server = new RpcServer({
      runRegistry: registry, runLog, journal, parentCwd: dir, hasAsyncRunner: false, spawn: () => {},
    });
    runLog.append("fl-smoke", { type: "run:meta", runId: "fl-smoke", agent: "scout", model: "Test/m", task: "smoke", startedAt: Date.now(), track: false, todoId: null });
    runLog.append("fl-smoke", { type: "message", role: "assistant", text: "hi", turnIndex: 0 });
    assert.ok(emitted.some((e) => e.channel === "fleet:run:started"), "bus published run:started");
    assert.ok(emitted.some((e) => e.channel === "fleet:child:message"), "bus published child:message");
    const status = await server.handle({ id: "smoke-1", verb: "status", params: {} });
    assert.equal(status?.ok, true, "status replies ok");
    const observe = await server.handle({ id: "smoke-2", verb: "observe", params: { runId: "fl-smoke", tier: "child" } }) as { ok: boolean; data?: { events: unknown[] } };
    assert.equal(observe.ok, true);
    assert.equal(observe.data?.events.length, 1, "observe replays the journaled child event");
    bus.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the smoke to verify it passes**

Run: `npx tsx --test test/smoke.test.mts` (timeout 120s) → all smoke tests PASS (the builtins section needs the workflow harness — if it requires provider config locally, run only the new test with `--test-name-pattern` and rely on CI for the rest; the NEW test must be env-independent and pass anywhere).

- [ ] **Step 3: Write the README section**

Add to `README.md` (after the latest release-features section, matching the existing tone — see the "Cross-cwd everywhere (v0.16.0)" section for format):

```markdown
## Event bus + RPC (v1.0)

armory-fleet publishes every run on pi's cross-extension event bus and answers an RPC verb
set — so your own extensions can spawn, steer, observe, and abort subagents programmatically.

### Event stream (broadcast, `pi.events`)

Two tiers, every event enveloped as `{ runId, seq, ts, ...payload }` (`seq` = per-run
monotonic, one space per source store):

| Channel | Payload |
|---|---|
| `fleet:run:started` | `{ agent, model?, cwd?, sessionCwd?, mode: foreground\|background\|scheduled\|workflow, task }` |
| `fleet:phase:started` / `completed` / `failed` | `{ phase, … }` (lifecycle runs) |
| `fleet:run:ended` | `{ status: completed\|failed\|aborted, result?, error?, filesTouched?, toolCallCount?, durationMs? }` |
| `fleet:child:message` | `{ role, text }` (journal excerpts) |
| `fleet:child:tool` | `{ toolName, args, result, isError }` (one per completed tool call) |

### RPC (`fleet:rpc` → `fleet:rpc:result`)

Emit `{ id, verb, params }`, get exactly one reply `{ id, ok, data }` or
`{ id, ok: false, error: { code, message } }`. Verbs: `spawn` (returns `{ runId }`
immediately; result arrives via `fleet:run:ended`), `status`, `observe` (replay dump —
subscribe to the broadcast channels + dedupe by `(channel, runId, seq)` for the live tail),
`steer`, `abort`.

Error codes: `E-CONTROL-DISABLED`, `E-RUN-NOT-FOUND`, `E-RUN-FINISHED`, `E-BAD-VERB`,
`E-BAD-PARAMS`, `E-STEER-UNSUPPORTED`, `E-INTERNAL`.

### Client helper (~15 lines)

```ts
type FleetReply = { id: string; ok: true; data: any } | { id: string; ok: false; error: { code: string; message: string } };
let n = 0;
export function fleetRpc(pi: { events: { emit(c: string, d: unknown): void; on(c: string, h: (d: unknown) => void): () => void } }) {
  return <T = any>(verb: string, params?: Record<string, unknown>): Promise<T> => {
    const id = `fleet-${Date.now().toString(36)}-${++n}`;
    return new Promise<T>((resolve, reject) => {
      const unsub = pi.events.on("fleet:rpc:result", (raw) => {
        const r = raw as FleetReply;
        if (r.id !== id) return;
        unsub();
        r.ok ? resolve(r.data as T) : reject(new Error(`${r.error.code}: ${r.error.message}`));
      });
      pi.events.emit("fleet:rpc", { id, verb, params });
    });
  };
}
// const rpc = fleetRpc(pi); const { runId } = await rpc("spawn", { agent: "scout", task: "look" });
```

### Control gate

`spawn`/`steer`/`abort` are on by default. Set `ARMORY_FLEET_RPC_CONTROL=0` (or `false`) to
reject them with `E-CONTROL-DISABLED`; read-only `observe`/`status` stay available. Honest
threat model: in-process extensions already have full system access through pi itself — the
switch guards accidents, not adversaries.

### Live conversation viewer

`/fleet` → Runs → open a **running** run: the timeline overlay streams the child's
conversation as it happens (tail-follows; scroll up to read, back to the bottom to re-pin).
Finished runs replay from the journal exactly as before.
```

- [ ] **Step 4: Run full gates**

Run: `pnpm typecheck` → exit 0. Run: `pnpm test:run` (timeout 300s) → all pass including the new smoke.

- [ ] **Step 5: Commit**

```bash
git add README.md test/smoke.test.mts
git commit -m "docs+test: event-bus RPC README + release-gate rpc round-trip (SPEC-6-4 T7)"
```

---

## Post-plan (outside this plan's scope, per house convention)

1. Read-only review subagent over the whole branch before merge (`readOnly: true`, brief it with "what does the CLAUDE path do here?" for Task 2's threading + Task 5's spawn seam — gotcha #11).
2. Merge → **chore bump PR → `v1.0.0`** (annotated tag `git tag -a v1.0.0 -m "…"`, NEVER plain `git tag`) → CI publishes → release-gate smoke before the tag → dotfiles settings pin bump (`readlink ~/.pi/agent/settings.json` first).
3. File + close the SPEC-6-4 tracking issue; update PRD §8 status; update memory (`handoff-pointer.md`, `dogfood-gotchas.md`, `MEMORY.md`).

## Self-Review (run by the plan author)

- **Spec coverage:** §3.1 taxonomy → T3; §3.2 RPC + gate → T4/T5; §3.3 modules/stores → T1/T3/T5; §3.4 live viewer → T6; §4 errors → T4; §5 testing (frozen-surface pins T3/T4, per-backend pin — Task 2's fixture note + the reviewer brief cover the claude mapper; the `fleet:child:tool` event itself is backend-agnostic since `buildToolEvent` runs for both) → T2-T7; §6 scope → all tasks; §7 deferred (lifecycle/schedule/modelFallback over RPC) → T4 explicit E-BAD-PARAMS. No gaps found.
- **Placeholder scan:** none — every code step is complete; two implementer NOTEs where the real fixture/types must be copied from existing tests (T2) or reconciled against real types (T4) are instructions with exact sources, not TBDs.
- **Type consistency:** `FleetEnvelope`/`RpcReply`/`RpcRunSummary`/`LiveTimelineState` names match across tasks; `subscribe(handler: (runId, event))` signature identical in T1/T3/T6; `runId?`/`mode?` opts from T2 consumed by T4's verb (`runId` pre-mint) and T5's lambda (`runId`, `mode` default). `E-LOCKED` was dropped from the spec (async-uniform spawn surfaces lock failures via `fleet:run:ended` with the lock error text — richer than a reply code); the spec enum edit accompanies this plan.
