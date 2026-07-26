# SPEC-5b-2 — Live widget + FleetView

**Date:** 2026-07-26
**Sub-SPEC of:** SPEC-5b (Fleet TUI)
**Package:** `@getpipher/armory-fleet` · target release `0.7.0` (minor)
**Predecessors:** SPEC-5a (v0.5.2 — `RunRegistry.subscribe` + `BgRunsStore` live-refresh seam); SPEC-5b-1 (v0.6.0 — `RunLog` + Runs tab)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context

SPEC-5b-2 is the second sub-SPEC of SPEC-5b (Fleet TUI). It delivers the two persistent, display-only surfaces PRD §8 calls for: a **live widget above the editor** (active runs, compact) and a **FleetView list below the editor** (active runs, list form). Both are display-only (`ctx.ui.setWidget`); `/fleet` remains the action surface. It consumes the `RunRegistry`/`BgRunsStore` live-refresh seam (v0.5.0) + the `RunLog` (v0.6.0), and fixes a token-unit bug inherited from 5b-1.

### The gap 5b-2 closes
- The `/fleet` panel is **on-demand** — the user must open it to see what the fleet is doing. There is no always-visible glance surface while subagents run.
- A long-running foreground subagent occupies the parent's turn; the user has no persistent indicator of fleet activity (agent · status · live duration · tokens) without switching context.
- Bg/lifecycle runs mutate `BgRunsStore` while the parent is idle; those changes are invisible unless the panel is open.

5b-2 adds two display-only widgets that render live from the existing store-change seam, so the fleet's active state is always a glance away — above the editor (compact) and below it (list).

### Token-unit bug fixed in 5b-2 (Q9)
5b-1 accumulates `e.message.usage?.cost?.total` into a variable named `tokenTotal` and renders it as `tok` in the Runs tab. But the pi SDK `Usage` type (`@earendil-works/pi-ai/compat`) is `{ input, output, cacheRead, cacheWrite, cost: { total } }` — `cost.total` is a **dollar** amount, not a token count. Real tokens = `input + output + cacheRead + cacheWrite`. 5b-1's "142 tok" was actually "$0.00142 shown as tok". 5b-2 introduces a live token surface (the widget) and fixes the unit here so the live surface ships honest.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| Q1 | FleetView navigability | **Display-only mirror** — pi widgets are display surfaces; "navigate" = open `/fleet` to act |
| Q2 | Scope | **Both surfaces in one SPEC (v0.7.0)** — same render path, two placements |
| Q3 | Widget content | **One compact line per active run** (above editor) |
| Q4 | Token/context% source | **Thread cumulative tokens into `RunRegistry`** (live); defer context% to SPEC-6 |
| Q5 | Widget visibility | **Active-only, hide when idle** — editor reclaims space |
| Q6 | FleetView list | **Active-only**, symmetric with the widget; hide when idle |
| Q7 | Refresh | **Subscribe seam + 1s interval timer** (start on first active, clear on idle/teardown) |
| Q8 | Rendering + testability | **Pure render fns + `setWidget(key, string[])`** — 5b-1 pattern verbatim |
| Q9 | Token unit | **Fix in 5b-2** — real tokens = `input+output+cacheRead+cacheWrite`; widen `ChildSessionEvent.usage`; `RunLog` extended; label stays `tok` (now honest) |

## 3. Architecture

Two display-only widgets registered at extension level in `index.ts` on `session_start`, **independent of the `/fleet` panel** (persist whether the panel is open or closed). A thin `FleetWidgetController` owns the subscribe + timer lifecycle and re-renders both placements on each store change or 1s tick.

```
session_start (index.ts)
  └─ new FleetWidgetController({ runRegistry, bgRuns, getTheme: () => ctx.ui.theme, ui: ctx.ui }).start()

FleetWidgetController
  ├─ runRegistry.subscribe(render)      # v0.5.0 seam
  ├─ bgRuns?.subscribe(render)          # v0.5.0 seam
  └─ setInterval(render, 1000)          # only while ≥1 active run

render()
  active = filterActive(toWidgetRun(RunRegistry.list()) ++ toWidgetRun(BgRuns.values()))
  active.length === 0 → setWidget("fleet-active", undefined) + setWidget("fleet-view", undefined) + clearTimer
  else → setWidget("fleet-active", renderWidgetLines(active, theme))
         setWidget("fleet-view", renderFleetViewLines(active, theme), {placement:"belowEditor"})
```

Both widgets are display-only (Q1=A). No keyboard input is routed to them; `/fleet` is the action surface.

## 4. Components

### New: `src/panel/widget-rows.ts` — pure render functions (unit-tested)
- `interface WidgetRun` — unified projection of `RunRecord` + `BgRunStatus`: `{ runId, agent, status, startedAt, endedAt?, tokenTotal?, phase?, phaseIndex?, phaseTotal?, kind: "fg" | "bg" }`.
- `toWidgetRun(r: RunRecord): WidgetRun` + `toWidgetRunFromBg(b: BgRunStatus): WidgetRun` — pure adapters.
- `filterActive(runs: WidgetRun[]): WidgetRun[]` — keep `running`/`queued`/`checkpoint`; newest-first by `startedAt` desc.
- `renderWidgetLines(runs: WidgetRun[], theme): string[]` — above-editor, one line per active run, cap **5** (overflow → `+N more in /fleet`): `▶ fl-xxx agent  3s  142 tok  ●phase 2/4`. Phase segment shown only when `phase` present (bg/lifecycle runs).
- `renderFleetViewLines(runs: WidgetRun[], theme): string[]` — below-editor list, active-only, cap **8**: same row shape, fuller (includes `mode`/`backend` for bg rows). Reuses `fmtDuration` + status glyphs from `rows.ts`.
- Duration: live `Date.now() - startedAt` (active runs have no `endedAt`).

### New: `src/panel/fleet-widget.ts` — `FleetWidgetController` (thin, TUI-smoke-gated)
- Constructor: `{ runRegistry, bgRuns?, getTheme: () => Theme, ui: { setWidget } }`.
- `start()`: subscribe both stores; do an initial `render()` (shows any runs already active on `session_start` — e.g. a bg run that survived restart).
- `render()`: compute active; if empty → clear both widgets + stop timer; else ensure timer running + set both widgets.
- `dispose()`: unsubscribe + clear timer + clear both widgets. Idempotent. Called on extension teardown.
- Timer lifecycle: started lazily on first active render, cleared when active empties (never a permanent timer).
- `disposed` flag guards `render()` against post-dispose store emissions.

### Changed: `src/engine/run-registry.ts`
- Add `tokenTotal?: number` to `RunRecord` (additive, like `resumedFrom`/`forkedFrom` in 5b-1).

### Changed: `src/engine/spawnSubagent.ts` (Q9 fix)
- Widen `ChildSessionEvent.message.usage` from `{ cost?: { total?: number } }` to `{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }`.
- On `message_end` (assistant): accumulate **real tokens** = `(input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)` into a local `tokenTotal`; `opts.runRegistry.update(runId, { tokenTotal })` (the new live seam for the widget).

### Changed: `src/runtime/run-log.ts` (Q9 fix, additive)
- Extend the `message` event's `usage` to carry `{ input, output, cacheRead, cacheWrite, total }` where `total` = real-token count **for that message/turn** (= `input+output+cacheRead+cacheWrite`), NOT dollars. (The run-level cumulative total lives separately in `run:ended.tokenTotal` and `RunRecord.tokenTotal`.) Keeps the `total` field for back-compat with 5b-1's `replay`/rows that read `usage.total`; `total`'s meaning is corrected from dollars to real tokens.
- `run:ended.tokenTotal` already sums from message events — now sums real tokens.
- `scanMeta`'s `RunListItem.tokenTotal` is now real tokens (no scan change; the source data is corrected upstream).

### Changed: `src/panel/runs-rows.ts` (Q9 fix, no label change)
- `runsRow` already renders `${r.tokenTotal} tok`; the value is now correct (real tokens). No string change.

### Changed: `src/index.ts`
- In `session_start`: construct + `start()` the `FleetWidgetController`; stash on `deps` for `dispose()`. Wire `getTheme: () => ctx.ui.theme` (live getter — the EditorTheme gotcha).
- The controller is independent of `openFleetPanel`; both coexist (widget is always-on glance, panel is on-demand overlay).

## 5. Data flow

```
session_start (index.ts)
  └─ FleetWidgetController.start()
       ├─ runRegistry.subscribe(render)
       ├─ bgRuns?.subscribe(render)
       └─ (timer started lazily on first active render)

spawnSubagent (every run)
  ├─ runRegistry.add(...)                          → subscribe → render()
  ├─ message_end → runRegistry.update(tokenTotal)  → subscribe → render()   # Q4/Q9
  └─ finishRun → runRegistry.update(status:completed) → subscribe → render()  # now filtered out → maybe hide

runBackground (async/bg)
  └─ onProgress → bgRuns.set(...)                   → subscribe → render()

render()  [event-driven OR 1s tick]
  active = filterActive(toWidgetRun(RunRegistry.list()) ++ toWidgetRun(BgRuns.values()))
  if active.length === 0 → setWidget("fleet-active", undefined) + setWidget("fleet-view", undefined) + clearInterval
  else → setWidget("fleet-active", renderWidgetLines(active, theme))
         setWidget("fleet-view", renderFleetViewLines(active, theme), {placement:"belowEditor"})
```

## 6. Error handling

| Failure | Behavior |
|---|---|
| `setWidget` throws | `render()` wraps each `setWidget` in try/catch → silent skip. A render failure never affects runs. |
| Timer leak | `dispose()` clears interval + unsubscribes; idempotent. Cleared on active-empty too. |
| Idle fleet | Both widgets cleared (`setWidget(key, undefined)`) → editor reclaims both slots. |
| Theme switch | `getTheme: () => ctx.ui.theme` live getter → next render reflects new theme, no re-wiring. |
| `bgRuns` absent (unit tests) | Controller degrades to RunRegistry-only; below-editor widget mirrors above. |
| Store emits mid-dispose | `disposed` flag in `render()` → no-op after dispose. |
| `tokenTotal` absent (backend omits usage) | `tokenTotal` stays undefined → row omits the `142 tok` segment (cosmetic, no crash). |
| Concurrent renders | `render()` is synchronous + idempotent (recomputes active from scratch each call); no stale state. |

## 7. Testing

**Unit tests (node:test via tsx) — the fast gate:**
- `widget-rows.test.mts` — `renderWidgetLines`/`renderFleetViewLines` (glyphs, live-duration format, phase segment, token segment, cap truncation with `+N more`, newest-first); `filterActive` (excludes completed/failed/aborted, keeps running/queued/checkpoint); `toWidgetRun` adapters (fg + bg); empty input → empty arrays.
- `run-registry.test.mts` — `tokenTotal` survives `add`/`update` (extend existing test).
- `spawn-subagent-widget.test.mts` (extend the existing runlog test) — fake backend emits `message_end` with `usage: { input:100, output:42, cacheRead:0, cacheWrite:0, cost:{total:0.001} }` → asserts `runRegistry.update` called with `tokenTotal: 142` (real tokens, NOT `0.001`); asserts `RunLog` message event records real-token `usage.total`.
- `fleet-widget.test.mts` — `FleetWidgetController` with fake `runRegistry`/`bgRuns`/`ui.setWidget` (recorded calls): active run added → both `setWidget` called; completion → both cleared + timer cleared; `dispose()` idempotent + clears timer; timer re-renders duration (fake timers).

**Term-driven TUI smoke (the gate, per 5b-1 carry-forward):** fresh temp cwd (not a real repo), start a foreground run → verify above-editor widget shows the active row with **ticking** duration (3s→4s→5s); below-editor FleetView shows it too; on completion both **hide** and editor reclaims space; start a bg run via the subagent tool's `background:true` → widget shows the bg row with phase segment; restart pi in same cwd → no orphan widget (active-empty on boot). Use `send` for literal letters, `sendKey` ONLY for named keys (the 5b-1 `r`/`f` lesson).

**The tsx-masks-loader caveat (carried from v0.5.1/5b-1):** unit tests passing does NOT mean pi's production loader accepts the code. **Gate the release on the term-driven TUI smoke**, not just unit tests.

**No new external deps. No vendored plumbing (pure application code). No build step.**

**~+25 tests on top of 274. typecheck clean. Release `@getpipher/armory-fleet@0.7.0`** (minor: live widget + FleetView + token-unit fix; no breaking API — `RunLog` `usage` gains fields additively, `total` repurposed from dollars→tokens is the one semantic change, documented + tested).

## 8. Scope boundaries (anti-gold-plating)

**In 5b-2:** live widget (above) + FleetView (below), `FleetWidgetController`, pure `widget-rows` render fns, `tokenTotal` into `RunRegistry`, **token-unit fix** (Q9: widen `ChildSessionEvent.usage`, real-token accumulation, `RunLog` extended), unit + term smoke.

**Deferred:**
- Context% (SPEC-6 — needs model max-context + a defensible "current context" definition; cost-aware tier is the right home).
- Interactive FleetView navigation / key capture (Q1=A — panel is the action surface).
- Finish-flash / recent-completed in FleetView (Q6=A — Runs tab + `RunLog` already hold history).
- Mid-run steering (5b-4), conversation viewer (5b-3).
- Widget settings/toggles (Q5/Q6=A — no config surface needed).

## 9. Risks

- **Above-editor space:** pi caps widget at `MAX_WIDGET_LINES=10`, truncates with "...". Cap widget at 5 + `+N more in /fleet` overflow line. FleetView cap 8.
- **Timer correctness:** a leaked timer wakes the renderer forever. Mitigated by lazy-start + clear-on-empty + `dispose()`. The unit test + smoke verify clear-on-completion.
- **Q9 fix touches just-shipped v0.6.0:** the `RunLog` `usage` shape change is additive (new fields; `total` repurposed from dollars to real tokens). 5b-1's `runsRow` label stays `tok` and becomes correct. Existing 5b-1 run-log tests updated to expect real-token `total`. No breaking API for consumers reading `RunLog.replay` (the `usage` object gains fields; `total`'s meaning changes — documented in the spec + a test asserts real-token accumulation).
- **`tokenTotal` double-counting across resumed runs:** a resumed run is a new `RunRecord` with its own `tokenTotal` (fresh accumulation) — correct, no double count.
- **Active-set flapping:** a run completing then a new one starting within the same tick — `render()` is idempotent (recomputes active from scratch each call), so no stale state.

## 10. References
- PRD §8 (SPEC-5b line), §5 (interactive-first), §7 (architecture foundation)
- v0.5.0 `RunRegistry.subscribe` + `BgRunsStore.subscribe` — the live-refresh seam this consumes
- v0.6.0 `RunLog` + Runs tab — the token-unit fix (Q9) touches `run-log.ts` + `runs-rows.ts`
- pi widget API: `ctx.ui.setWidget(key, string[] | undefined, {placement})` (`docs/tui.md` Pattern 5), `ctx.ui.theme` live getter (EditorTheme gotcha, `~/local-dev/getpipher/AGENTS.md`)
- pi `Usage` type: `@earendil-works/pi-ai/compat` — `{ input, output, cacheRead, cacheWrite, cost: { total } }` (`cost.total` = dollars, NOT tokens)
- getpipher conventions: `~/local-dev/getpipher/AGENTS.md` (interactive-first, EditorTheme gotcha, no AI attribution, `--test-timeout=30000` in `test:run`)