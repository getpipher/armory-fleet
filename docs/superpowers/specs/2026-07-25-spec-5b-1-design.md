# SPEC-5b-1 — RunLog seam + Runs view (replay/resume/fork)

**Date:** 2026-07-25
**Sub-SPEC of:** SPEC-5b (Fleet TUI)
**Package:** `@getpipher/armory-fleet` · target release `0.6.0` (minor)
**Predecessors:** SPEC-5a (v0.5.2 — `RunRegistry.subscribe` + `BgRunsStore` live-refresh seam is the foundation this builds on)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context

SPEC-5b (PRD §8) bundles five surfaces: FleetView, live widget, conversation viewer, mid-run steering, and a Runs view (replay/resume/fork). It is too large for one spec. Per the PRD's sequencing principle (moat-first, each SPEC independently shippable) and the 5a/5b split precedent, SPEC-5b is decomposed into ordered sub-SPECs:

- **5b-1 (this):** message-level journal seam + Runs view (replay/resume/fork). Front-loads the shared seam 5b-2/5b-3 consume, plus the lowest-risk new tab.
- **5b-2:** live widget + FleetView (above/below-editor persistent surfaces).
- **5b-3:** conversation viewer (live-scrolling overlay — the full-message body view; 5b-1 reserves the timeline `enter` key for it).
- **5b-4:** mid-run steering (inline composer; gated on an inject-into-running-session capability probe).

### The gap 5b-1 closes
- `RunRegistry` is **in-memory** → on pi restart it is empty. A "completed runs" view backed by it would show nothing after a restart.
- `spawnSubagent` discards the rich child-session event stream (assistant messages, tool calls, per-turn usage) — it keeps only `finalText` + `tokenTotal`. No conversation is persisted.
- `RunJournal` (phase-level, bg/lifecycle only) persists per-run but at the wrong granularity and coverage for a Runs view over all runs.

5b-1 introduces a **self-describing per-run log** (`RunLog`) written from `spawnSubagent` for every run (foreground, bg, lifecycle-phase), and a **Runs tab** that scans it to rebuild the run list across restarts, with replay/resume/fork actions.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| Q1 | Journal fidelity | **Curated/readable** — assistant text (full), tool `name` + `args` excerpt ≤200ch + `result` excerpt ≤500ch, **errors-in-full** (`isError:true` result untruncated), per-turn `usage`, turn boundaries. Not streaming deltas. |
| Q2 | Journal storage + write hook | **New `RunLog`, one file per run**, written from `spawnSubagent` (the single chokepoint all runs flow through) via an optional port. `RunJournal` (phase-level, bg) untouched. |
| Q3 | Replay depth | **Per-turn timeline**, scrollable (`SelectList`); one row per turn with glyphs + excerpts + per-turn usage. `enter` on a timeline row is a no-op placeholder reserved for 5b-3's full-message overlay. |
| Q4 | Runs-view actions | **Replay + Resume + Fork**, all three in 5b-1 (full PRD §8 Runs-view parity). |
| Q5 | Runs-tab data source across restarts | **Self-describing journal** — `RunLog` carries `run:meta` + `run:ended` events alongside message/tool events; Runs tab scans first+last line per file. Renamed from `MessageJournal` to `RunLog`; dir `.pi/fleet/runs/`. |

## 3. Architecture

One new durable seam (`RunLog`) + one new panel tab (Runs). Everything else reuses existing patterns — the v0.5.0 `subscribe` seam, the panel tab machinery, SPEC-3's resume infra (`ResumeStore` + `SessionManager.open`).

```
                         ┌─────────────────────────────────────┐
   spawnSubagent ───────▶│ RunLog  (.pi/fleet/runs/<runId>.jsonl)│
   (ALL runs: fore/bg/   │  run:meta → message/tool → run:ended │
    lifecycle-phase)      └───────────────┬─────────────────────┘
        │                                  │ scan first+last line
        │ runRegistry.add/update            ▼
        ▼                               RunLogIndex
   RunRegistry (in-memory, live)  ──▶  (durable run list, restart-safe)
        │ subscribe (v0.5.0)              │
        ▼                                 │
   FleetPanel                          FleetPanel
     Fleet / Lifecycle / Agents / Backends / Scheduled
                          + [runs]  ← NEW tab
                                       │ enter=Replay  R=Resume  F=Fork
                                       ▼
                                  RunLog.replay(runId)
```

**One file per run, self-describing.** `RunLog` is the single source of truth for a run's full history — meta + conversation. `RunRegistry` (in-memory) still drives the *live* Fleet tab; `RunLog` (durable) drives the *historical* Runs tab. Two stores answer different questions: `RunRegistry` = "what's happening now"; `RunLog` = "what happened, ever."

## 4. Components

### New: `src/runtime/run-log.ts` — `RunLog`
Append-only JSONL per run (`.pi/fleet/runs/<runId>.jsonl`), `mkdirSync` recursive (mirrors `RunJournal`). Crash-safe: partial last line discarded on read.

**Event union:**
- `{type:"run:meta", runId, agent, model, task, startedAt, backendSessionId?, sessionKey?, track, todoId?}` — written on spawn start, and re-written when `session_init` arrives with `backendSessionId`/`sessionKey` (so resume can find the sessionKey even if the run is mid-flight at crash). A run may therefore have 1–2 `run:meta` events; `scanMeta` resolves the binding per §6 (latest `run:meta` wins for `backendSessionId`/`sessionKey`; first `run:meta` for `startedAt`).
- `{type:"message", role, text, usage?, turnIndex}` — on assistant `message_end`.
- `{type:"tool", toolName, args(excerpt≤200ch), result(excerpt≤500ch OR full if isError), isError, turnIndex}` — on `tool_execution_end`.
- `{type:"run:ended", runId, status, endedAt, resultSummary?, tokenTotal, resumedFrom?, forkedFrom?}` — on run completion.

Methods:
- `append(runId, event): void`
- `replay(runId): RunLogEvent[]` — full read (partial last line discarded).
- `scanMeta(): RunMeta[]` — reads each file's `run:meta` + last `run:ended` (if present) to rebuild the durable run list. Cheap (≈2 lines per file; may scan to last `run:meta` for the latest session binding).

Port shape, constructor takes `dir: string`.

### New: `src/panel/runs-index.ts` — `buildRunsIndex` (pure, tested)
`buildRunsIndex(logDir): RunListItem[]` — wraps `RunLog.scanMeta()`, sorts newest-first by `startedAt`, maps to the row shape. Pure function (like `buildFleetItems` in v0.5.0) for unit-testability.

### New: `src/panel/runs-rows.ts`
- `runsRow(r: RunListItem): string` — `✓ fl-xxx  agent  32s  142 tok  "summary"  ← resumed:fl-prior` (provenance arrow when present). Reuses `fmtDuration` + glyphs.
- `runTimelineRow(e: RunLogEvent): string` — the per-turn timeline row: `[a] "excerpt" 142 tok` / `[t] read src/index.ts ✓` / `[t] bash pnpm test:run ✗ "Error: test not found"`.

### Changed: `src/engine/spawnSubagent.ts`
- New optional opt: `runLog?: RunLog`.
- New optional opts: `resumeLink?: string` / `forkLink?: string` (passthrough → written into the new run's `run:ended` event + `RunRecord`).
- On `runRegistry.add` → `runLog?.append(runId, {type:"run:meta", …})`.
- In `session.subscribe`:
  - `session_init` with `backendSessionId` → `runLog?.append(runId, {type:"run:meta", …(with binding)})`.
  - assistant `message_end` → `runLog?.append(runId, {type:"message", …})`.
  - `tool_execution_end` → `runLog?.append(runId, {type:"tool", …})`.
  - `turn_start` → increment in-memory `turnIdx` counter (local to the `spawnSubagent` call).
- On `finishRun` (single completion path) → `runLog?.append(runId, {type:"run:ended", resumedFrom: opts.resumeLink, forkedFrom: opts.forkLink, …})`.
- **No behavior change when `runLog` is absent** (existing 247 tests stay clean). All appends are `opts.runLog?.append(...)`.

### Changed: `src/engine/run-registry.ts`
- Add optional `resumedFrom?: string` and `forkedFrom?: string` to `RunRecord` (additive, like `backendSessionId`/`sessionKey` in SPEC-3). `finishRun` sets them from `opts.resumeLink`/`opts.forkLink`.

### Changed: `src/panel/fleet-panel.ts`
- `View` adds `"runs"`. Tab order: `fleet → lifecycle → runs → agents → backends → scheduled → fleet`.
- New deps field: `runLog?: RunLog` (the Runs tab source). Tab degrades to empty list when absent.
- **Runs tab** (`buildList` branch): `buildRunsIndex(deps.runLog.dir)` → `runsRow()` rows.
- **Replay overlay-state:** `selectedRun: RunListItem | null` + `runTimeline: RunLogEvent[] | null`. On `enter`/`i` → `runLog.replay(runId)` → render `runTimelineRows()` as a scrollable `SelectList`. `enter` on a timeline row = no-op placeholder for 5b-3. `esc` → back to Runs list.
- **Resume action (`R`):** requires `run.backendSessionId` && status ∈ {completed,failed,aborted}. Guarded: if absent → `onNotify("no resumable session for this run", "warning")`. Otherwise opens inline `Input` "follow-up> " → `executeResume()`: `spawnSubagent({agent: prior.agent, task: followUp, resumeLink: prior.runId, …})`. The agent's `sessionKey` == `prior.sessionKey` → factory rehydrates via `ResumeStore`/`SessionManager.open` (existing SPEC-3 path).
- **Fork action (`F`):** any completed run. Opens `startRun` prefilled (agent + task from prior), fresh session (no `sessionKey` reuse), `forkLink: prior.runId`.
- Reuses the existing `runMode`/`linkPhase` input machinery for resume/fork inputs (no new input state class).
- Live refresh: the Runs tab benefits from the existing `runRegistry.subscribe` wired in the constructor (v0.5.0) — an in-flight run's `run:ended` (written right after `runRegistry.update`) triggers `refresh()` → re-scan.

### New: `src/runtime/reconcile.ts` — `reconcileRuns(log, opts)`
On pi boot, mark any `run:meta`-without-`run:ended` whose process is gone (age > grace window, default 60s) as `run:ended {status:"aborted", reason:"process-gone"}`. Cheap scan, runs once. This is the only new startup code. (Foreground orphans; bg/lifecycle orphans already handled by SPEC-5a `scanResumeCandidates`.)

## 5. Data flow

### Write path — `spawnSubagent` → `RunLog` (every run)
```
spawnSubagent(opts)
  ├─ runRegistry.add({runId,…})         ──▶ runLog.append(runId, run:meta)      # 1st event
  ├─ factory.create({agent:{sessionKey}}) → session
  └─ session.subscribe((e) =>
       ├─ session_init + backendSessionId → runRegistry.update + runLog.append(run:meta)  # re-meta
       ├─ turn_start                     → turnIdx++
       ├─ message_end (assistant)        → runLog.append(runId, {message, turnIndex: turnIdx})
       ├─ tool_execution_end             → runLog.append(runId, {tool, turnIndex: turnIdx})
       └─ turn_end                       → (budget consume; no log event)
     )
  finishRun(runId, status, …)
    ├─ runRegistry.update(runId, {status, endedAt, resultSummary, tokenTotal, resumedFrom, forkedFrom})
    └─ runLog.append(runId, run:ended)                                    # last event
```
- `run:meta` written **before** the child spawns; `run:ended` written **after** `runRegistry.update`.
- `turnIndex` resets per `spawnSubagent` call (local `let turnIdx = -1`, increment on `turn_start`). Each lifecycle-phase spawn has its own counter → its own `RunLog` file → consistent indexing within a run.

### Read path — Runs tab across restarts
```
User opens /fleet → tab to [runs]
  → buildList("runs") → buildRunsIndex(runLog.dir)
    → for each <runId>.jsonl: read run:meta + last run:ended (if present)
    → RunListItem { runId, agent, model, task, status: ended?.status ?? "running",
                    startedAt, endedAt?, resultSummary?, tokenTotal?,
                    backendSessionId?, sessionKey?, resumedFrom?, forkedFrom? }
    → rows: runsRow(item)
```
- Live refresh via the existing `runRegistry.subscribe` (no new seam). For runs from a prior session (no in-memory registry), the tab is static until a keypress/`r` re-scan.

### Replay flow — `enter`/`i` on a Runs row
```
Runs tab, row selected, press enter/i
  → selectedRun = item; runTimeline = runLog.replay(runId)
  → render runTimelineRows(runTimeline) as scrollable SelectList
     [a] "I'll read the file first…"                              142 tok
     [t] read  src/index.ts  ✓
     [t] bash  pnpm test:run  ✗  "Error: test not found"
     [a] "The test path was wrong; fixed it."                     88 tok
  → hint: "enter: (5b-3 full message)  esc:Back"
  → enter on a timeline row: no-op (5b-3 wires the full-message overlay)
  → esc: selectedRun = null; back to Runs list
```
- `runTimelineRows` renders **message + tool events only** (skips `run:meta`/`run:ended`), in file order (chronological).

### Resume flow — `R` on a completed run with `backendSessionId`
```
Runs tab, row selected (status ∈ {completed,failed,aborted}, backendSessionId present), press R
  → if !run.backendSessionId → onNotify("no resumable session for this run", "warning"); return
  → resumeInput = new Input(); prompt "follow-up> "
  → onSubmit(followUp) → executeResume(prior, followUp):
      spawnSubagent({ agent: prior.agent, task: followUp, track: true,
                      resumeLink: prior.runId, registry, todoSync, runRegistry, lock,
                      backendRegistry, parentModel, parentCwd, runLog })
  → (sessionKey reuse is automatic: prior.agent.sessionKey == prior.sessionKey;
     factory.create rehydrates via ResumeStore/SessionManager.open)
  → new RunRecord.resumedFrom = prior.runId; new run:ended.resumedFrom = prior.runId
```
- If `ResumeStore` has no entry / session file deleted → factory falls back to a fresh session (existing SPEC-3 behavior) + `onNotify("session not resumable; started fresh", "warning")`.

### Fork flow — `F` on any completed run
```
Runs tab, row selected (status ∈ {completed,failed,aborted}), press F
  → startRun(prior.agent) with taskInput pre-filled = prior.task   # reuse existing run-mode input
  → onSubmit: executeRun(prior.agent, prior.task, todoId?)        # fresh session
  → new RunRecord.forkedFrom = prior.runId; new run:ended.forkedFrom = prior.runId
```
- Reuses the existing `startRun` → `executeRun` machinery; only adds prefill + `forkLink` opt.

### Provenance display
`runsRow` appends ` ← resumed:fl-<prior>` / ` ← forked:fl-<prior>` when `run.ended.resumedFrom`/`forkedFrom` present. Visible in the Runs tab (and the Fleet tab for recent runs via the same `RunRecord` fields).

## 6. `scanMeta` semantics (multi-`run:meta`)

A run may have two `run:meta` events (initial, then re-meta on `session_init` with the session binding). `scanMeta` resolves the **latest** binding by reading the file's events up to the last `run:meta` (or, for efficiency, the last `run:meta` before the first `run:ended`). `RunListItem.backendSessionId`/`sessionKey` come from the latest `run:meta`; `startedAt` from the first. This keeps resume correct (uses the bound sessionKey) while staying cheap (most runs have 1–2 `run:meta` events).

## 7. Error handling

| Failure | Behavior |
|---|---|
| `RunLog.append` I/O error | `spawnSubagent` wraps each `opts.runLog?.append` in `try/catch` → silent skip. **The run is the product; the journal is the index.** A journal write failure never fails the run. |
| Partial last line (crash mid-append) | `replay()`/`scanMeta()` discard un-parseable trailing lines. Next append overwrites cleanly. |
| Orphan `run:meta` with no `run:ended` (pi killed mid-run) | `scanMeta` reports status `"running"`. On next boot, `reconcileRuns(log)` marks orphans older than the grace window (60s) as `run:ended {status:"aborted", reason:"process-gone"}`. |
| Resume when session gone | Factory falls back to a fresh session (existing SPEC-3 behavior) + `onNotify("session not resumable; started fresh", "warning")`. Honest, not silent. |
| Resume when run has no `backendSessionId` | `R` guarded: `onNotify("no resumable session for this run", "warning")`. |
| Fork when agent no longer registered | `startRun` already guards: `registry.get(name)` → `onNotify("agent 'X' not found", "error")`. No new code. |
| `runLog` opt absent (unit tests) | All appends `opts.runLog?.append(...)` — no-op. Existing 247 tests untouched. |
| Concurrent append from two threads | Can't happen: one `spawnSubagent` per run, one file per run. |
| `scanMeta` reading a file being appended | Append-only + last-line-discard → eventual consistency on next scan. Never corrupts. |

## 8. Testing

**Unit tests (node:test via tsx) — the fast gate:**
- `run-log.test.mts` — append/replay round-trip; partial-last-line discard; `scanMeta` rebuilds the list (with + without `run:ended`); multi-`run:meta` (latest binding wins); excerpt helpers (args≤200, result≤500, **errors-in-full**); event ordering.
- `runs-index.test.mts` — `buildRunsIndex` newest-first sort; provenance surfaces in the row; status fallback (`running` when no `run:ended`).
- `runs-rows.test.mts` — `runsRow` + `runTimelineRow` rendering (glyphs, excerpts, token line, provenance arrow).
- `spawn-subagent-runlog.test.mts` — `spawnSubagent` with a temp-dir `RunLog` + fake backend factory emitting `session_init`/`message_end`/`tool_execution_end`/`turn_start`/`turn_end` → asserts journal contains `run:meta` + message + tool + `run:ended` in order; **asserts no journal written when `runLog` opt omitted** (the no-behavior-change invariant).
- `panel-runs.test.mts` — FleetPanel Runs tab: `buildList("runs")` renders rows from `runLog`; `enter`/`i` opens timeline overlay; `R` disabled when no `backendSessionId`; `F` prefills `startRun`. Reuses the `panel-spec5a.test.mts` harness pattern.
- `reconcile.test.mts` — orphan `run:meta` (no `run:ended`, older than grace) → `reconcileRuns` marks `aborted`; fresh orphan (within grace) left `running`; completed run untouched.
- `run-registry.test.mts` — `resumedFrom`/`forkedFrom` survive `add`/`update` (additive; extend the existing test).

**The tsx-masks-loader caveat (carried from v0.5.1):** unit tests passing does **not** mean pi's production loader accepts the code (the cron-parser CJS-in-ESM bug passed 244 unit tests but crashed pi). **Gate the release on the term-driven TUI smoke**, not just unit tests:
- Fresh temp cwd (**not** pointing at a real repo — the v0.5.1 foreground-subagent isolation caveat), `/fleet` → tab to `runs` → verify a foreground run that just completed appears with `✓` + provenance; `enter` opens the timeline; `R` on a resumable run opens the follow-up input; `F` prefills. **Restart pi in the same cwd** → Runs tab still shows the run (restart-safety). This is the real gate, mirroring v0.5.0/5.1/5.2.

**No new external deps. No vendored plumbing (pure application code). No build step.**

**~+30 tests on top of 247. typecheck clean. Release `@getpipher/armory-fleet@0.6.0`** (minor: new Runs tab + `RunLog` seam; no breaking API).

## 9. Scope boundaries (anti-gold-plating)

**In 5b-1:** `RunLog` (meta/message/tool/ended), Runs tab (scan + rows + replay timeline + resume + fork + provenance), `spawnSubagent` write hook, `reconcileRuns` on boot, unit + term smoke.

**Deferred:**
- 5b-3: the full-message overlay (timeline `enter` is the placeholder).
- 5b-2: the above/below-editor live widget + FleetView persistent list (the Runs tab is panel-internal, not the persistent widget).
- 5b-4: mid-run steering (inject into running session).
- Journal retention/pruning (a future `/fleet prune` or SPEC-6; journals accumulate for now — small, curated).
- Cross-session conversation search (shell `grep` over `.pi/fleet/runs/` works; no in-TUI search in 5b-1).

## 10. Risks

- **`turnIndex` availability:** `turn_start` carries `turnIndex` (pi SDK confirmed). If a backend omits `turn_start`, `turnIdx` stays at -1 → timeline rows show `turnIndex: -1` (cosmetic only; no crash). Mitigation: clamp to ≥0 in `runTimelineRow`.
- **`scanMeta` cost at scale:** ≈2 lines × N files. For 1000s of runs this is still <100ms. If it ever matters, an in-memory index file (`runs.idx`) is a future optimization — YAGNI for 5b-1.
- **Multi-`run:meta` ambiguity:** resolved by "latest binding wins" (§6). A run that never reached `session_init` has one `run:meta` with no binding → `backendSessionId` undefined → `R` disabled (correct: nothing to resume).
- **Resume sessionKey race:** two resumed runs of the same agent share one `sessionKey` → `ResumeStore` collision. Pre-existing SPEC-3 concern, out of 5b-1 scope. Mitigation: document; a future per-resume-sessionKey is a 5b-4/SPEC-6 concern.

## 11. References
- PRD §8 (SPEC-5b line), §5 (interactive-first panel), §7 (architecture foundation)
- v0.5.0 `RunRegistry.subscribe` + `BgRunsStore` seam — the live-refresh pattern this extends
- `RunJournal` (`src/runtime/run-journal.ts`) — the append-only self-describing pattern `RunLog` mirrors
- SPEC-3 resume: `ResumeStore` + `SessionManager.open` path in `src/index.ts`
- pi SDK event types: `session_init`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`_update`/`_end` (`dist/core/extensions/types.d.ts`)
- getpipher conventions: `~/local-dev/getpipher/AGENTS.md` (interactive-first, EditorTheme gotcha, no AI attribution)