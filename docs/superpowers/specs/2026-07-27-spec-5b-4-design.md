# SPEC-5b-4 — Mid-run steering (inline composer) + Stop

**Date:** 2026-07-27
**Sub-SPEC of:** SPEC-5b (Fleet TUI)
**Package:** `@getpipher/armory-fleet` · target release `0.9.0` (minor)
**Predecessors:** SPEC-5b-1 (v0.6.0 — `RunLog` + Runs tab + timeline overlay); SPEC-5b-2 (v0.7.0 — live widget + FleetView); SPEC-5b-3 (v0.8.0 — conversation viewer full-message overlay + timeline interactivity fix)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context

SPEC-5b-4 is the fourth and final sub-SPEC of SPEC-5b (Fleet TUI). It delivers **mid-run steering** — the inline composer that lets the user redirect a running subagent mid-flight — plus **Stop** (abort mid-run). These are the last two items in the PRD §5 action submenu ("Steer (mid-run message)" + "Stop") and the final entry in the 5b decomposition (5b-1 §1: "5b-4: mid-run steering (inline composer; gated on an inject-into-running capability probe)").

### The capability-probe gate (resolved ✅)

5b-4 was gated on whether the pi SDK supports injecting a user message into an **in-flight** child session. The probe confirms it does, natively:

| pi SDK primitive | Behavior |
|---|---|
| `session.steer(text)` | Queue a steering message — delivered after the current assistant turn finishes its **tool calls** (mid-turn interrupt steering). |
| `session.followUp(text)` | Queue a message — delivered only when the agent **stops** (end-of-run). |
| `session.isStreaming` | Boolean — is the session currently in-flight? |
| `session.abort()` | Abort the current operation. |
| `queue_update` event | `event.steering` + `event.followUp` arrays — observe queued-message state. |

**Gate verdict: PASS.** `steer()` is a first-class SDK primitive — exactly the inject-into-running capability 5b-4 was gated on. The riskiest sub-SPEC drops to ~medium risk.

### The two gaps 5b-4 closes

The pi SDK supports steer, but armory-fleet's current architecture strips it:

1. **`ChildSession` interface strips the steer API.** The engine's `ChildSession` (`src/engine/spawnSubagent.ts`) exposes only `prompt` / `subscribe` / `abort` / `dispose`. No `steer`, no `isStreaming`. The pi backend's `wrapPiSession()` forwards only those four — even though the underlying `piSession` (a real `AgentSession`) has `steer()`/`isStreaming` natively. The claude backend (`ClaudeChildSession`) is a child process with a single-shot blocking `prompt()` (one `turnResolve`, resolved on `turn_end`) — a second `prompt()` mid-flight would clobber the resolver.
2. **The session is not retained; `spawnSubagent` blocks + disposes.** `spawnSubagent` is a synchronous blocking call: it `await`s `session.prompt(opts.task)` then `session.dispose()` in `finally`. The session object is local to the function. By the time control returns to the panel/tool, the session is gone. There is nothing to steer. True for both foreground (`subagent` tool) and background (`runBackground` → lifecycle → `spawnSubagent`) paths.

5b-4 widens `ChildSession` with optional steer methods, retains the in-flight session as a narrow `LiveSessionHandle` on `RunRecord`, and wires Steer + Stop actions in the Fleet tab.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| Q1 | Scope: fold in live conversation viewer (deferred from 5b-3 Q4=A)? | **A — steering-only.** Live-scrolling deferred to SPEC-6. Ships the risky write-side seam isolated; the live pane (read-side) lands cleanly in SPEC-6 on top of the proven retained-handle seam. |
| Q2 | Backend coverage | **A — pi-only steer; claude degrades honestly.** Pi backend forwards the native SDK `steer()`/`isStreaming`; claude's `steer()` is unsupported (`supportsSteer: false`). Claude steer is a focused follow-up probe, not a 5b-4 deliverable. |
| Q3 | Steer semantics | **A — `steer()` only.** Mid-turn interrupt semantics, matching PRD §5 "Steer (mid-run message)" singular intent. `followUp()` is semantically 5b-1 Resume (a follow-up after completion) — already shipped. |
| Q4 | Session-retention seam | **A — extend `RunRegistry` / `RunRecord`.** Add `session?: LiveSessionHandle` to `RunRecord`. Cohesive with the existing `backendSessionId`/`sessionKey` (durable binding) fields — the live handle is the transient counterpart. One registry, one lookup. |
| Q5 | Steering interaction surface | **A — Steer action on the selected running row.** Inline `Input` `steer> `, reusing the 5b-1 Resume input machinery. Consistent with the PRD §5 action-submenu model. A persistent composer is the right UX for the live-pane console (SPEC-6), not 5b-4. |
| Q6 | Stop parity | **A — wire Stop too.** The retained handle exposes `abort()` by construction; the panel action is the same row-action pattern minus the input. PRD §5 lists both; the two mid-run interventions share the entire retained-handle seam. |
| Approach | Implementation strategy | **1 — widen `ChildSession` + narrow `LiveSessionHandle` on `RunRecord`.** Steer is a first-class opt-in capability (`supportsSteer` flag); honest degradation falls out of optional methods. Keeps `ChildSession` as the single decoupling layer (SPEC-3 design intent). |

## 3. Architecture

One new narrow handle interface + one optional field on `RunRecord` + three optional methods on `ChildSession`. `spawnSubagent` retains the in-flight session as a `LiveSessionHandle` on the run record for the run's lifetime; the panel reaches it via the existing `runRegistry.get(runId)` read path and exposes Steer (pi-only) + Stop (any backend) as row actions on running runs.

```
spawnSubagent(opts)
  ├─ runRegistry.add({runId, status:"running", …})
  ├─ backend.factory.create({...}) → { session: ChildSession }
  ├─ runRegistry.update(runId, { session: toLiveHandle(session) })              ← NEW: retain
  ├─ session.subscribe(...)  // 5b-1 RunLog writes unchanged
  ├─ await session.prompt(task)
  └─ finishRun → runRegistry.update(runId, { status, session: undefined })      ← NEW: clear (in finally)
                    │
   FleetPanel (Fleet tab, running row selected)
     ├─ run = runRegistry.get(runId)   // existing read path
     ├─ handle = run.session           // NEW: the live handle (or undefined if finished)
     ├─ Steer action (if handle?.supportsSteer)
     │    └─ inline Input "steer> " → handle.steer(text) → pi session.steer(text)
     └─ Stop action  (if handle)
          └─ handle.abort() → session.abort() → finishRun(status:"aborted")
```

**The handle is the single new seam.** `LiveSessionHandle` is a narrow interface — `steer`, `isStreaming`, `abort`, `subscribe`, `supportsSteer` — built from the (widened) `ChildSession` by `toLiveHandle()`. It deliberately does NOT expose `prompt` or `dispose` (the panel must not start new prompts or tear down the session). The handle lives on `RunRecord.session` only while `status === "running"`; `finishRun` clears it in the same `update` patch that sets the terminal status, so a stale reference can never leak past the run's lifetime.

**No store, no timer, no journal change.** `RunLog` (5b-1) writes are unchanged — steer is not a journaled event (it's a user input, not a child-session event; the steered message's *effect* shows up as subsequent `message`/`tool` events in the journal naturally). The `queue_update` event is not surfaced in 5b-4 (cosmetic; a future "steer queued" indicator is a SPEC-6 polish).

## 4. Components

### New type: `LiveSessionHandle` (in `spawnSubagent.ts` alongside `ChildSession`)
```ts
export interface LiveSessionHandle {
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(handler: (e: ChildSessionEvent) => void): () => void;
  readonly isStreaming: boolean;
  readonly supportsSteer: boolean;
}
```
Narrow by design — no `prompt`, no `dispose`. The panel can redirect, cancel, observe, and read liveness — nothing else.

### New helper: `toLiveHandle(session): LiveSessionHandle`
Factory in `src/engine/spawnSubagent.ts` (or a tiny `src/engine/live-handle.ts`). Wraps a `ChildSession`:
- `steer` → `session.steer?.(text) ?? Promise.reject(new Error("steer not supported on this backend"))`
- `abort` → `session.abort()`
- `subscribe` → `session.subscribe(handler)`
- `isStreaming` → `session.isStreaming ?? false`
- `supportsSteer` → `typeof session.steer === "function"`

### Changed: `ChildSession` interface — three optional methods
```ts
export interface ChildSession {
  prompt(text: string): Promise<void>;
  subscribe(handler: (e: ChildSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  // NEW (SPEC-5b-4) — optional, opt-in per backend:
  steer?(text: string): Promise<void>;
  readonly isStreaming?: boolean;
}
```
Optional → existing `ClaudeChildSession` and all unit-test fakes compile unchanged (no `steer` = `supportsSteer: false`).

### Changed: `RunRecord` (`src/engine/run-registry.ts`) — one optional field
```ts
export interface RunRecord {
  // …existing fields…
  /** SPEC-5b-4: live session handle while status === "running"; cleared by finishRun. */
  session?: LiveSessionHandle;
}
```
Transient, in-memory only — never written to `RunLog` (the journal append in `spawnSubagent` constructs a plain object, not the `RunRecord`).

### Changed: `wrapPiSession` (`src/index.ts`) — forward the three new methods
```ts
function wrapPiSession(inner: ChildSession, backendSessionId: string): ChildSession {
  return {
    prompt: (t) => inner.prompt(t),
    abort: () => inner.abort(),
    dispose: () => inner.dispose(),
    subscribe: (h) => { h({type:"session_init", backendSessionId}); return inner.subscribe(h); },
    steer: (t) => inner.steer?.(t) ?? Promise.reject(new Error("pi session has no steer")),  // ← NEW
    get isStreaming() { return inner.isStreaming ?? false; },                                  // ← NEW
  };
}
```
`inner` is the real `piSession` cast as `ChildSession` — its `steer`/`isStreaming` are the SDK's native methods. The getter form keeps `isStreaming` live (reflects the session's streaming state at call time, not capture time).

### Changed: `ClaudeChildSession` — no code change
The optional methods stay `undefined` on the claude backend → `toLiveHandle` yields `supportsSteer: false`. (A future probe could add a stdin-queue `steer`; not in 5b-4.)

### Changed: `spawnSubagent` — register + clear the handle
- After `backend.factory.create(...)` succeeds, before `session.subscribe`:
  `opts.runRegistry.update(runId, { session: toLiveHandle(session) });`
- In `finishRun`'s `runRegistry.update(runId, { status, endedAt, … })` patch: add `session: undefined` to clear it.
- The `session.dispose()` in the `finally` block stays — the handle is cleared *before* dispose (finishRun runs first, then the outer finally disposes). After dispose, any in-flight `handle.steer()` call rejects (the pi session is torn down) — the panel's submit handler `try/catch`es and `onNotify` the error.
- **No behavior change when the run has no retained handle** — the handle is always set on `RunRecord` (the seam is unconditional); the panel's *actions* are conditional on `run.session?.supportsSteer`. Existing 303 tests stay clean because the handle field is additive and the panel isn't unit-tested (codebase pattern).

### Changed: `fleet-panel.ts` — two new row actions on the Fleet tab
- **Steer** (key: `s` or via action submenu): enabled only when `run.status === "running" && run.session?.supportsSteer`. Opens inline `Input` `steer> ` (reuses the 5b-1 Resume input machinery). On submit → `run.session.steer(text)` in a `try/catch` → `onNotify("steer queued; lands after current tool calls", "info")` on success / `onNotify("steer failed: …", "error")` on reject. `esc` cancels the input (no steer).
- **Stop** (key: `x` or action submenu): enabled when `run.status === "running" && run.session`. Calls `run.session.abort()` → the existing `finishRun(status:"aborted")` path fires (the abort signal + `session.abort()` already work). `onNotify("run aborted", "info")`.
- Footer hint on the Fleet tab updates to show `s:Steer  x:Stop` when a running row is selected (conditional, like 5b-1's hint).
- Both actions are no-ops with a notify when the guard fails (e.g. `onNotify("steer not supported on claude backend", "warning")`, `onNotify("run already finished", "warning")`).

### Not changed
- `RunLog`, `RunJournal`, `BgRunsStore`, `FleetWidgetController`, the write path's journal events, the 5b-1/5b-3 overlay code, `run-lifecycle.ts`, `async-runner.ts` (bg runs get steer for free — the handle is on the `RunRecord` regardless of fore/bg path).

## 5. Data flow

### Steer path (pi backend, foreground or bg run)
```
Fleet tab, running row selected (run.session?.supportsSteer === true), press s
  → inline Input "steer> " renders (reuses 5b-1 Resume input machinery)
  → user types "Actually, also check the error handling in src/foo.ts" + Enter
  → onSubmit(text):
      if (!run.session) { onNotify("run already finished", "warning"); return; }   // re-check (race)
      try { await run.session.steer(text);
            onNotify("steer queued; lands after current tool calls", "info"); }
      catch (e) { onNotify(`steer failed: ${e.message}`, "error"); }
  → renderShell() (input closes, back to Fleet tab)
  // meanwhile, in the child session (async, no panel block):
  //   the pi SDK queues the text; when the current turn's tool calls finish,
  //   the SDK delivers it as a new user message → the agent's next turn
  //   incorporates it. The resulting message/tool events flow through the
  //   existing session.subscribe → RunLog.append path (5b-1). The steer
  //   itself is NOT journaled (it's a user input, not a child event);
  //   its effect shows up as subsequent [a]/[t] rows in the RunLog naturally.
```
- `steer()` resolves once the SDK accepts the queue (not when the agent processes it). The notify says "queued" — honest about the async gap.
- If the run finishes between the user pressing `s` and submitting, `run.session` is now `undefined` (finishRun cleared it) → the submit handler re-checks and notifies.

### Stop path (any backend, any running run)
```
Fleet tab, running row selected (run.session present), press x
  → if (!run.session) { onNotify("run already finished", "warning"); return; }
  → try { await run.session.abort(); onNotify("run aborted", "info"); }
    catch (e) { onNotify(`abort failed: ${e.message}`, "error"); }
  → session.abort() → the existing spawnSubagent abort path fires:
      aborted = true; await session.prompt rejects/returns;
      finishRun(runId, "aborted", …) → runRegistry.update(runId, {status:"aborted", session:undefined})
  → runRegistry.subscribe → FleetPanel refresh → row shows ✗ aborted, Steer/Stop disabled
```
- No confirmation prompt (Stop is immediate, like the PRD §5 action submenu implies). A future "are you sure?" is gold-plating for 5b-4.

### Handle lifecycle (the invariant)
```
spawnSubagent:
  runRegistry.add({…, status:"running"})            // session: undefined
  backend.factory.create(...) → session
  runRegistry.update(runId, {session: toLiveHandle}) // ← handle set
  try { await session.prompt(task) }
  finally {
    finishRun → runRegistry.update(runId, {status, session: undefined})  // ← handle cleared
    session.dispose()
  }
```
**Invariant: `run.session` is non-null ⟺ `run.status === "running"`.** `finishRun` clears the handle in the same patch that sets the terminal status, atomically (one `runRegistry.update` call). The panel's guards (`run.session?.supportsSteer`) are therefore always consistent with the status shown.

### The claude-backend row
A running claude-backend run shows in the Fleet tab with `run.session` present (`abort` works — `ClaudeChildSession.abort()` kills the process) but `supportsSteer === false`. Steer action is disabled / shows `onNotify("steer not supported on claude backend", "warning")` if invoked. Stop works normally.

### Bg runs
A background run's `RunRecord` is in the same `runRegistry` (the lifecycle engine's phase spawns flow through `spawnSubagent`, which sets `run.session`). The Fleet tab shows the bg run's current phase child as a row; Steer/Stop reach the phase's in-flight session handle. When the phase completes and the next phase spawns, the handle rolls to the new child (new `spawnSubagent` → new `runId` per the 5b-1 `turnIdx` reset note + the lifecycle's per-phase `genRunId`). So the bg run's *current phase child* is steerable as its own row; the parent lifecycle run is observed via `BgRunsStore` (5b-2) which is display-only. This matches the existing model — each `spawnSubagent` call is one row in the Fleet tab.

## 6. Error handling

| Failure | Behavior |
|---|---|
| `steer()` rejects (pi session torn down / SDK error) | Panel submit handler `try/catch` → `onNotify("steer failed: <message>", "error")`. The run continues unaffected — a failed queue is not a run failure. |
| Steer submitted but run finished between render + submit | Submit handler re-checks `if (!run.session) { onNotify("run already finished", "warning"); return; }`. The handle was cleared by `finishRun`; the check is authoritative. |
| Steer on a claude-backend run | Guard: `if (!run.session?.supportsSteer) { onNotify("steer not supported on claude backend", "warning"); return; }` — the input never opens. |
| `abort()` rejects | `onNotify("abort failed: <message>", "error")`. The run may still be running; the user can retry Stop. |
| Stop on an already-finished run | Guard: `if (!run.session) { onNotify("run already finished", "warning"); return; }`. |
| Handle leaks past run lifetime (stale reference) | Impossible by construction: `finishRun` clears `session: undefined` in the same `runRegistry.update` patch as the terminal status. The `session.dispose()` in the outer `finally` tears down the underlying session regardless. |
| `steer()` called after `dispose()` (race: user submits as the run ends) | The pi SDK's `steer()` on a disposed session rejects — caught by the submit handler's `try/catch`. No crash, no hang. |
| `isStreaming` read after dispose | The getter returns `false` (the wrapped session is gone); defensive `?? false` in `toLiveHandle`. Cosmetic — the row already shows terminal status. |
| Unit-test fakes that don't implement `steer`/`isStreaming` | Optional methods → `toLiveHandle` yields `supportsSteer: false`, `isStreaming: false`. Existing 303 tests compile + pass unchanged (no fake needs editing). |
| Concurrent steer + steer (user mashes `s` twice) | The pi SDK queues both; they're delivered in order. The panel's `Input` is modal (one at a time) so this can't happen via the panel, but a programmatic caller could. Harmless. |
| `runLog` opt absent (unit tests) | Unchanged from 5b-1 — all journal appends are `opts.runLog?.append(...)`. The handle seam is independent of the journal. |

## 7. Testing

### Unit tests (node:test via tsx) — the fast gate

- **`live-handle.test.mts`** — `toLiveHandle` wrapping: a fake session with `steer`/`isStreaming` → `supportsSteer: true`, `steer` forwards, `isStreaming` reflects live; a fake without `steer` → `supportsSteer: false`, `steer()` rejects with "steer not supported"; `abort`/`subscribe` forward; `isStreaming` defaults `false` when absent.
- **`run-registry.test.mts`** (extend existing) — `session` field survives `add`/`update` (additive); `update(runId, {session: undefined})` clears it; the `RunRecord` plain object never carries the handle into `RunLog` append calls (assert the journal append receives a handle-free object).
- **`spawn-subagent-steer.test.mts`** — a fake backend factory whose session has `steer`/`isStreaming` + a temp-dir `RunLog`: after `backend.factory.create` resolves, `runRegistry.get(runId).session` is set + `supportsSteer === true`; after the run completes, `run.session === undefined` (cleared by finishRun). A second fake whose session lacks `steer` → `supportsSteer === false` on the handle. Assert the handle is set *before* `session.prompt` is awaited (so a steer during the run reaches it). Reuses the `spawn-subagent-runlog.test.mts` harness pattern.
- **`panel-steer.test.mts`** — extend the `panel-runs.test.mts` harness with a `RunRecord` carrying a fake `LiveSessionHandle`: Fleet tab Steer action (`s`) on a running steerable run → inline `Input` opens → submit → `handle.steer(text)` called with the typed text → `onNotify("steer queued…", "info")`; `esc` → no steer call. Steer on a claude-backend run (`supportsSteer: false`) → `onNotify("steer not supported on claude backend", "warning")`, input never opens. Steer on a finished run (`session: undefined`) → `onNotify("run already finished", "warning")`. Stop action (`x`) on a running run → `handle.abort()` called → status flips to `aborted`. Stop on a finished run → guard notify. Assert the Fleet-tab footer hint shows `s:Steer  x:Stop` only when a running row is selected.

### Term-driven TUI smoke (the gate — per 5b-1/5b-2/5b-3 carry-forward)

**5b-4 is a WRITE-side feature → the smoke MUST use a real live subagent run** (cannot fake an in-flight session). Budget tokens + time for a cheap-model run that stays in-flight long enough to steer + stop.

Smoke flow (fresh temp cwd, cheap model, a task with a long tool call so the run stays in-flight):
1. Spawn a foreground subagent with a task like `Run: bash "sleep 8 && echo done", then report the result` — the `sleep 8` keeps the run in-flight long enough to act.
2. Open `/fleet` → tab to Fleet → the running row appears with `s:Steer  x:Stop` in the hint.
3. **Steer gate:** press `s` → `steer> ` input → type a steer message + Enter → `onNotify("steer queued…")` appears. Use `send` for literal letters, `sendKey` ONLY for named keys (the 5b-1 `r`/`f` lesson).
4. **Stop gate:** (separate run, or after the steer lands) press `x` on a running row → `onNotify("run aborted")` → row shows `✗ aborted`, Steer/Stop disabled.
5. **Guard gates:** `s` on a finished row → "run already finished" warning; `x` on a finished row → same.
6. **Claude-backend gate (if claude is installed):** a running claude run → `s` → "steer not supported on claude backend" warning; `x` → abort works.
7. **State hygiene:** after the run completes/aborts, `run.session` is `undefined` (verify via the Runs tab — the completed run's conversation is intact via 5b-1/5b-3, no handle leak).

**Two smoke runs minimum** — one for Steer (verify the steer message lands: the run's subsequent assistant text should reference the steered instruction), one for Stop (verify abort). Cheap model + `sleep` keeps cost/time bounded.

### No new external deps. No vendored plumbing. No build step. No journal change.

**~+14 tests on top of 303. typecheck clean. Release `@getpipher/armory-fleet@0.9.0`** (minor: new Steer + Stop mid-run intervention surface; the `ChildSession` widening is additive (optional methods) — no breaking API, but the new capability warrants a minor bump).

## 8. Scope boundaries (anti-gold-plating)

**In 5b-4:** `LiveSessionHandle` + `toLiveHandle`, `ChildSession` optional `steer`/`isStreaming`, `RunRecord.session`, `wrapPiSession` forwarding, `spawnSubagent` register/clear, Fleet-tab Steer + Stop actions, unit + term smoke.

**Deferred:**
- Live conversation viewer / live-scrolling (Q1=A — SPEC-6, pairs with the live-pane console).
- `followUp()` panel action (Q3=A — 5b-1 Resume covers the end-of-run follow-up intent).
- Claude-backend steer (Q2=A — a focused follow-up probe on `claude -p` stream-json mid-turn injection; not a 5b-4 deliverable).
- Persistent composer line in the Fleet tab (Q5=A — the right UX for the SPEC-6 live-pane console, not 5b-4).
- `queue_update` event surfacing (a "steer queued" live indicator — cosmetic SPEC-6 polish).
- Stop confirmation prompt (immediate Stop is the PRD §5 intent; a confirm is gold-plating).
- Steer as a journaled `RunLog` event (the steer is a user input; its effect shows up as subsequent message/tool events naturally — no new event type).

## 9. Risks

- **`steer()` delivery timing is SDK-defined, not fleet-controlled.** The pi SDK delivers the steer "after the current assistant turn finishes its tool calls" — there's no fleet-side guarantee the agent picks it up before making more tool calls. The notify says "queued" honestly. If the agent is mid-tool-call, the steer lands after that tool call completes. Acceptable — this is the SDK's defined semantics, not a fleet bug.
- **Race: run finishes between `s` press + submit.** Mitigated by the submit handler's re-check (`if (!run.session)`). The `Input` closing on `renderShell` after a `runRegistry.subscribe`-triggered refresh is a related concern — the panel's `Input` is rendered inside `ctx.ui.custom`; if a registry update fires mid-input, the re-render could close the input. The plan verifies the panel's input-mode guard (5b-1's Resume input has the same concern; verify the existing pattern handles it).
- **`isStreaming` getter liveness on the wrapped session.** `wrapPiSession` uses `get isStreaming()` to delegate to `inner.isStreaming` live. If the pi SDK's `isStreaming` is a getter on the `AgentSession` prototype, this works. If it's a property captured at session creation, it's stale. The plan verifies the pi SDK's `AgentSession.isStreaming` is a live getter (the SDK docs list it as `isStreaming: boolean` on the interface — verify it reflects live state).
- **Bg run handle rolls per phase.** A bg lifecycle run's `runId` is the lifecycle run's id (5b-1 §5: `genRunId` overridden to the async runner's runId), but each phase spawn is its own `spawnSubagent` call with its own `runId`? — the 5b-1 note says "each lifecycle-phase spawn has its own `RunLog` file" (§5 turnIndex reset). Need to verify: does the phase child's `runId` == the lifecycle runId (handle on the lifecycle row) or a fresh per-phase runId (handle on a transient phase row that may not surface in the Fleet tab)? The plan resolves this — if phase children aren't Fleet-tab rows, Steer on a bg lifecycle run's row needs the *current phase child's* handle, which may require the lifecycle engine to surface the active phase child's runId. **This is the one open implementation detail** — it doesn't change the design (the handle seam is the same) but it determines which row Steer acts on for bg lifecycle runs. Foreground single-delegate runs are unaffected (one runId, one handle, one row).
- **`ChildSession` widening ripple.** Adding optional methods to an interface is non-breaking, but every `ChildSession` implementation + fake is now expected to *consider* `steer`/`isStreaming`. The unit-test fakes compile unchanged (optional), but the plan audits whether any existing fake's shape should explicitly declare `supportsSteer: false` for clarity.

## 10. References

- PRD §8 (SPEC-5b line: "mid-run steering (inline composer)"), §5 (interactive-first panel — action submenu: "Steer (mid-run message)" + "Stop"), §7 (architecture foundation: `createAgentSession`)
- pi SDK `steer()` / `followUp()` / `isStreaming` / `abort()` / `queue_update`: `~/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` (Prompting and Message Queueing + Events sections)
- SPEC-5b-1 (`docs/superpowers/specs/2026-07-25-spec-5b-1-design.md`) — the 5b decomposition (5b-4 = inline composer, gated on the inject-into-running probe this spec resolves) + the inline `Input` machinery Steer reuses
- SPEC-5b-3 (`docs/superpowers/specs/2026-07-26-spec-5b-3-design.md`) — carry-forward conventions (pure renderers, term-smoke gate, publish-then-smoke flow, overlay structure)
- `src/engine/spawnSubagent.ts` — `ChildSession` interface + `spawnSubagent` lifecycle (the two gaps this closes)
- `src/engine/run-registry.ts` — `RunRecord` (the `session?` field lands here)
- `src/index.ts` — `wrapPiSession` (forwards the new methods) + `createChildFactory` (the pi backend)
- `src/backend/claude-session.ts` — `ClaudeChildSession` (no change; `supportsSteer: false` by omission)
- `src/panel/fleet-panel.ts` — the Fleet tab + action submenu + inline `Input` pattern Steer/Stop extend
- getpipher conventions: `~/local-dev/getpipher/AGENTS.md` (interactive-first, EditorTheme gotcha, no AI attribution, `--test-timeout=30000` in `test:run`)