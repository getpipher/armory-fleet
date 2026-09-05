# SPEC: Fleet Presentation Redesign — 3-Surface TUI/UX

**Date:** 2026-09-03 · **Status:** Approved by RECTOR (brainstorm 2026-09-03; design sections + before/after mockups shown and approved; render lifecycle verified against pi source). P1 SHIPPED via PR #109 (merge `3f85c3e`). P2 delta ratified 2026-09-03 (Q1–Q3: #108 folded in; tree shape A; ↓ re-follow) — see §5 P2 + §7.
**Scope:** Presentation layer only — transcript rendering, widget, `/fleet` panel. **No engine/behavior changes, no journal/RPC schema changes, no key remaps.**
**Design authority:** oh-my-pi structure × Claude Code restraint (locked with RECTOR). Explicitly rejected aesthetics: OpenClaw cards, gemini-cli personality, aider per-stream color.

---

## 1 · Problem

armory-fleet's operational depth is invisible until the user opens `/fleet`:

- **Transcript:** `subagent`/`fleet` tool calls render as pi's default tool row + a raw text envelope. While runs execute, the transcript shows nothing. Completed runs dump a narrative blob.
- **Widget:** plain uncolored strings; no totals; no visual hierarchy.
- **Panel:** flat single-color rows; mixed glyph languages (rows use `▶⏸✓✗⏳`, gate-line uses emoji `✅⛔↻⚠`); no totals header; no lineage view despite lineage data existing (`resumedFrom`/`forkedFrom`/`childRunIds`); full-message overlay wraps at hardcoded width 80.

Reference experience (RECTOR's screenshot, oh-my-pi): timestamped activity, live job tree with spinners and elapsed clocks, TODO checklist tree with strikethrough progress, subagent roster with task excerpts, restrained green-accent-on-dark aesthetic. That is the bar for "professional on the fly."

## 2 · Design language (locked)

**Token budget = pi's existing theme tokens only.** No hardcoded hex anywhere; the user's pi theme flows through everything.

- Status → token map (single source `src/present/tokens.ts`):
  `running → accent` · `queued → dim` · `paused → warning` · `completed → success` · `failed/aborted → error` · `stale → warning + bold`
  (exact `success`/`error` token availability verified at implementation; fallback set `accent/text/muted/dim/warning` is proven in-repo.)
- Escalation via **intensity (`bold`) and the bg states pi already applies** (`toolPendingBg` → `toolSuccessBg`/`toolErrorBg` on finalize — native), never extra hue.
- **Glyph vocabulary** (single source `src/present/glyphs.ts`; nothing renders a glyph not defined here):
  status `▶ ⏸ ✓ ✗ ⏳` · spinner braille `⣾⣽⣻⢿⡿⣟⣯⣷` · connectors `├ └ ─ │` · continuation `↳` · cross-cwd `↗` · ellipsis `…` · card frame `╭─╮│╰─╯` (self-shell only).
  **Emoji purge:** `✅⛔` in gate-line → `✓ ✗↻⚠` from this table.
- **`usage —` honesty rule:** missing per-run data renders literal `—`; never estimated, never silently omitted.
- Truncation is semantic (`↳` continuation glyph at a break), replacing hard `slice(0, N)` in primary labels.

## 3 · Surface 1 — transcript, in-flight

### 3.1 Verified render lifecycle (contract — pi source, oh-my-pi is a fork of this substrate)

| Transition | Mechanism (source refs) |
|---|---|
| Appear | `ToolExecutionComponent` constructed at call start; `renderCall(args, theme, ctx)` invoked immediately; re-invoked on every `updateDisplay()` (`packages/coding-agent/src/modes/interactive/components/tool-execution.ts`) |
| Args streaming | `updateArgs()` → `renderCall` re-invoked; `ctx.argsComplete` flag |
| Partial progress | `execute(toolCallId, args, signal, onPartial)` — 4th param emits partials (`pi-agent-core/dist/agent-loop.js:455`) → `tool_execution_update` → `renderResult(partial, { isPartial: true })` (`interactive-mode.js:2726`); `acceptingUpdates` gate blocks post-finalize partials |
| Self-animation | `ctx.invalidate()` → `row.invalidate() + ui.requestRender()`; sanctioned pattern = pi-tui `Loader` (private `setInterval`, 80ms ≈ 12.5fps status track) via `ctx.lastComponent` reuse; renders coalesce (`tui.ts:772–812`) |
| Finalize | `tool_execution_end` → `updateResult(final, isPartial=false)` → `renderResult` final call; row bg flips `toolPendingBg → toolSuccessBg/toolErrorBg` natively |
| After finalize | Row is a durable transcript artifact; re-renders only on expand toggle (`app.tools.expand` + `keyHint()`), resize (`render(width)` re-wrap), theme change. **Renderer must stop its interval at finalize (`Loader.stop()`) — timer cleanup is the renderer's responsibility.** |
| Disappear | Never mid-session; only `hideComponent` (empty render) or session compaction |
| Crash safety | Per-slot `try/catch` → fallback rendering (tool name / raw output) |
| Framing | `renderShell: "self"` for full control of the card frame (docs cite "visually stable after settle" as the intended use) |

### 3.2 Run card (the `subagent` and `fleet` tools)

**`renderCall`** — appears at dispatch, live while executing:

```
╭─ ⣾ fleet · reviewer · glm-5.2 ────────────────────────╮
│  task   Review PR #102 for the routing regression      │
│  state  ⣾ tool:read · turn 3 · 41s · 186K tok · 18%    │
╰────────────────────────────────────────────────────────╯
```

- Self-shell, box frame; spinner = embedded `Loader` (braille frames from glyphs.ts); elapsed clock via the same tick.
- The `state` line is driven by **forwarding the child-run events we already receive through `onEvent` as `onPartial` payloads** (turn index, last event class, tokens, ctx%). No polling; the timer only animates.
- Steer/stop markers: `⏸ steer queued`, `✗ aborted` render in the state line when they occur.

**`renderResult`** — collapsed summary on finalize; `expanded` (native `app.tools.expand`, hint via `keyHint()`) reveals the full envelope (args, result, error — current content, unchanged):

```
╰─ ✓ reviewer · 4m12s · 598K tok · $0.30 · ✎3 · verdict: Ship
```

- `usage —` rule applies: a failed/aborted run shows `✗ reviewer · — tok · — $ · ✗"reason excerpt"`.
- Warning prefixes (zero-tool `[FLEET]`, language-drift, fallback-used) surface as a flagged line inside the expanded view AND as a `⚠` glyph on the collapsed line.

### 3.3 Orchestration entry (fleet-wide live block)

Human-only, **zero LLM tokens**: `pi.appendEntry(customType)` + `pi.registerEntryRenderer()`. One live entry per dispatch-burst; renderer reads RunRegistry/BgRunsStore/todo store **live at render time** (re-rendered on event ticks):

```
ⓘ waiting on 3 runs · $0.94 · 598K tok
├ ⣾ reviewer     41s   ●tool:read   18%
├ ⣾ implementer  2m03s ●edit        34%
└ ⏳ scheduler   queued
TODO
├─ SPEC-6-7 panel redesign · 2/5
│  ├ ☑ totals header        → r-8f3 ✓ 4m12s
│  ├ ☑ row color language   → r-9a1 ✓ 6m40s
│  ├ ☐ state-machine footer → ⣾ r-b2c · 41s
│  └ ☐ lineage tree toggle
☾ waiting on gate: review-pass
```

- TODO tree is a **read-only projection** of armory-todo (§6), strikethrough on done, N/M rollups from the progress blocks `updateLifecycleProgress` already maintains.
- Appended when a fleet run starts (or first event arrives while none is live); removed from live rotation when the burst goes idle (widget-idle rule reused: no active runs → no live block).

### 3.4 Findings block (burst end — oh-my-pi's pattern)

Durable entry appended when the burst's last run settles:

```
── findings ────────────────────────────────
✓ reviewer     4m12s  598K tok  $0.30 — Ship (1 NIT: ANSI width)
✓ implementer  6m40s  412K tok  $0.83 — committed abc1234, ✎3
✗ scheduler    —      —         —      worker exited without result (TODO reverted ⚠)
⚠ fallback used once: openrouter/z-ai/glm-5.2 (rate-limit)
```

One line per run (status glyph, duration, tok, $, one-clause outcome), degradations as `⚠` lines (fallback, zero-tool, language-drift — the v1.2.0 signals get a face). Same data that today lands as prose notifications, restructured.

## 4 · Surface 2 — widget

`ctx.ui.setWidget(key, (tui, theme) => Component)` — component widget (colorized; strings today):

```
⣾ 2 running · $0.94 · 598K tok
├ ⣾ reviewer     41s   ●tool:read   18%  $0.11
├ ⣾ implementer  2m03s ●edit        34%  $0.83  ↗armory-todo
```

- Totals strip only when >1 active run. Segments: glyph (status token) · name (text) · meta (muted) · values (text) · cost (text).
- Existing semantics preserved: 1s clock, liveness segments after threshold, stale `⏰`, substrate/work label, `+N more` cap, cross-cwd `↗` with worktree-basename fix, abort warning folded into the totals strip as `⏰ fg abort on submit` when applicable.
- `EditorTheme` gotcha respected: widget factory receives the real render inputs from `setWidget`; theme always via live getter, never a captured factory arg.

## 5 · Surface 3 — `/fleet` panel

### P1 · Velocity
- **Totals header** under the tab bar: `⣾ 2 running · ✓ 1 done · $1.24 · 268K tok` (computed per render from the same stores the list reads).
- **Colorized rows:** labels are strings; `theme.fg` ANSI is embedded at build time in `rows.ts`/`runs-rows.ts`/`fleet-items.ts`. Status word replaced by status color (glyph already carries state); `●event`, `·Nt`, `✎N`, `$` segments per §2 map.
- **ANSI-aware width helper** (`src/present/width.ts`): strip-ANSI length for wrapping/truncation — current `wrapToLines` counts `.length` and ANSI codes would poison it. Prerequisite for any colored label wrapping.
- **State-machine footer:** one line, fixed budget, keys that matter now — browsing vs row-selected vs modal vs input states (per-view hint objects, not string literals scattered in `renderShell`).
- **Capability-aware actions:** aborted/failed rows read-only (`↻ re-run` offered instead of `x`); only `paused` resumable; `x` only on running rows; unavailable keys omitted from the footer, not just rejected.

### P2 · Structure (ratified 2026-09-03 — tree shape A, #108 folded in, ↓ re-follow)
- **`t` lineage tree toggle** in Runs/Fleet views: parent↔subagent grouping from `resumedFrom`/`forkedFrom` (Runs; resumedFrom takes precedence when both are set, matching the existing provenance column) and `childRunIds` (Fleet); one shared row renderer for flat and tree modes; `├─└─` connectors from glyphs.ts via a pure `layoutTree()` helper in `src/present/tree.ts` — DFS from roots sorted by startedAt, `│  `/`   ` indent continuation, orphans (parent named but absent) render top-level with `↳`, visited-set cycle guard, degrade to flat on missing fields. `t` is per-view, default flat, resets on panel close; footer gains `t:tree` only in these two views (capability-aware).
- **Overlay width fix (mechanism resolved):** `FleetPanel extends Container` and pi-tui passes the real viewport width to `render(width)` — the panel caches `lastWidth` there; `renderShell()` uses it at both hardcoded-80 sites (totals-header right-align + full-message overlay wrap, floor 40). The earlier "if live width is unreachable" contingency is closed: it is reachable.
- **Scroll-state separator (live-only):** while a run streams AND `LiveTimelineState.pinned === false`, the timeline footer line becomes warning-themed `↑ scrolled · live paused · ↓ end to re-follow` (the timeline has no box frame — footer line, not border). Re-follow gesture = the existing scroll-to-bottom re-pin in `LiveTimelineState.onKey`; **Enter keeps Full-message** (the original "enter to re-follow" collided with the bound Full-message action — rejected per §8 additive-only). Replay browsing stays unannotated.
- **#108 card fixes (folded in):** `renderCall` stops hand-rolling its frame and delegates to `liveCardLines` with a provisional `RunCardState` (unifies geometry — kills the missing-bar + handoff-fragment defects at wide terminals); named `CARD_WIDTH = 72` clamp replaces both hardcoded `80`s (subagent.ts renderCall/renderResult); regression test locks the null-segment separator join; the fallback+card double-render gets a time-boxed real-pi smoke investigation (pi-core cause → file upstream, park).

### P3 · Polish (ratified 2026-09-05 — env-var selection, nerd ships, live-only preview)
- **Symbol presets** (`unicode` default / `nerd` / `ascii`) as glyph-map variants in glyphs.ts. **Selection = `ARMORY_FLEET_GLYPHS` env var read once at module load** — static resolve: `export const GLYPHS: GlyphMap = pickPreset(process.env.ARMORY_FLEET_GLYPHS)`; invalid value (after trim + lowercase) → unicode + exactly one stderr warning; no runtime switching (rejected: accessor+setter mutates ~40 call sites for a rejected capability; ESM `export let` live binding silently degrades to per-module snapshots under CJS interop). Consumers keep `GLYPHS.x` unchanged (8 files). `GlyphMap` interface; three factory presets, per-preset key-parity tests. `nerd` = FontAwesome PUA icons (F04B play · F017 clock · F04C pause · F00C check · F00D times · F021 refresh · F071 warning · F05A info · F186 moon · F111 circle · F040 pencil · F141 ellipsis · F08E external-link · F046/F096 todo squares); tree/card box-drawing + continuation + todoStruck **stay unicode** (connectors render fine in nerd fonts — nerd's value-add is icons, not connectors); nerd spinner frames are smoke-verified candidates (F110/F021/F1CE/F013) — visual pick by RECTOR in the real-pi smoke, data-only swaps after.
- **Segmented footer separators**: new `footerSep` glyph (`│` U+2502 in unicode+nerd, `|` in ascii) + one `hint(...parts)` join helper. Scope = the footer hint bar (all 5 `footerFor` states) and the `timelineFooter` warning line **only**. Totals header, card state line, row segments, findings, orchestration segments keep `·` (intra-row value separators; totals strip is normative in the Appendix mockup).
- **Live run-card preview row** in the Fleet tab (the selected run's state line rendered as it appears in-transcript). State-line join extracted from `liveCardLines` into pure `stateLine(s, now, frame)` — byte-identical, existing card pins untouched. `previewLine(selectedId, {registry, bgRuns}, now, frame)` resolves the selected fleet item via `cardSnapshot` (registry) or the `bgToCard` adapter (bg pool, lifted to an importable spot). Renders **only for `status === "running"`** (live preview); reserved blank line otherwise (stable height, no flicker); unthemed — literally as in-transcript, zero `theme.fg` exposure; no width clamp (all segments bounded, ~55 cols < `CARD_WIDTH`); not a selectable row — rendered between list and footer. Runs-view preview parked.
- Acceptance (§7): ascii preset renders glyph-free fallbacks everywhere (no mojibake on dumb terminals) — key-parity tests are the structural guarantee, the real-pi ascii smoke is the visual one; default (no-env) rendering stays byte-identical to v1.3.0 except the footer separators.
- Dropped as over-promise: replacing pi's own footer/statusline (that canvas is pi's, not an extension's).

## 6 · armory-todo intersection

- **Write-side (ships today, unchanged):** `TodoSyncPort.linkOrCreateRunTodo`, `markRunTodoDone/Reverted`, `updateLifecycleProgress` (phase-progress block = single source of truth).
- **Read-side (new):** one method on the port — `listFleetTodos(scope?)` returning fleet-run/lifecycle TODOs with status + title + linked runId — implemented in `ArmoryTodoAdapter` (the sole importer of `@getpipher/armory-todo`; insulation preserved per SPEC-1 §6).
- **Boundary (firm):** armory-todo owns the store and ALL editing UX. Fleet surfaces are read-only projections; `o:Open-todo` remains the deep-link. No duplicated write paths.

## 7 · Phasing & acceptance criteria

**P1 — transcript velocity (first shippable increment)**
1. `src/present/` (tokens, glyphs, ANSI-width) landed + tested.
2. Run card live on `subagent` tool: appears at dispatch, state line updates from child events via `onPartial`, spinner animates, finalizes to collapsed summary with `—` honesty on failure; expanded shows unchanged full envelope.
3. Findings block appended at burst end; orchestration live block during bursts.
4. Panel totals header + colorized rows + state-machine footer + capability-aware actions.
- **Accept:** manual real-pi smoke (card appears/live/finalizes; no timer leak after finalize — verified by rendering a second burst); unit tests green; typecheck green; no LLM-context growth from entries (verified: entries are TUI-only custom type).

**P2 — structure**
5. ANSI-width-wrapped overlay at real width; scroll-state separator on live timeline; #108 card fixes (unified frame + 72-col clamp).
6. `t` lineage tree in Runs + Fleet views.
- **Accept:** replay a multi-run journal: tree groups correctly by lineage; live timeline scroll detaches with marker and re-follows on scroll-to-bottom; run card renders identical geometry at any terminal width (clamped 72).

**P3 — polish (ratified 2026-09-05)**
7. Symbol presets (unicode/nerd/ascii, `ARMORY_FLEET_GLYPHS` selection), segmented separators, live-only preview row.
- **Accept:** ascii preset renders glyph-free fallbacks everywhere (no mojibake on dumb terminals); default rendering byte-identical to v1.3.0 except footer separators; nerd preset icons eyeballed by RECTOR in the smoke; preview row ticks on a live run and blanks otherwise.

## 8 · Architecture

- **New:** `src/present/` — `tokens.ts` (status→token map), `glyphs.ts` (vocabulary + presets), `width.ts` (ANSI-aware measure/wrap/truncate), `tree.ts` (P2: `layoutTree()` DFS connector prefixes) · `src/transcript/` — `run-card.ts`, `orchestration-entry.ts`, `findings.ts` (**pure functions** returning components/strings; unit-testable, no TUI imports beyond pi-tui primitives).
- **Changed:** `src/todo-sync/port.ts` (+`listFleetTodos`), `src/todo-sync/adapter.ts` (impl), `src/index.ts` (renderer/entry registrations), `src/panel/fleet-panel.ts` (header/footer/rows wiring, P2: `lastWidth` capture + `t` toggle + separator), `src/panel/rows.ts`+`runs-rows.ts`+`fleet-items.ts` (segment styling, P2: tree prefix param), `src/panel/widget-rows.ts` → component widget controller, `src/tools/subagent.ts` (P2/#108: renderCall delegates to `liveCardLines`, `CARD_WIDTH` clamp).
- **Untouched:** engine, journal, RPC, scheduler, lifecycle runtime, tiers, workflows runtime. All existing keybindings keep their meanings; new keys (`t`, expand is native) only.
- Convention compliance: raw `.ts` via tsx (no build step); tests in `test/*.test.mts` only (repo test-discovery rule); interactive-first (panel/view first, tool action second).
- P3 additions: `present.ts` gains `hint()` + `footerSep` glyph; `run-card.ts` gains extracted `stateLine`; `rows.ts` exports `bgCardSnapshot` (lifted from the index.ts closure — `BgRunStatus` lives there; avoids a transcript→panel import); `fleet-panel.ts` renders the preview row between list and footer.

## 9 · Testing

- Unit (pure renderers): run-card collapsed/expanded/failed paths (`—` honesty), orchestration tree (empty store, mixed statuses, long-task truncation with `↳`), findings block (degradation lines), widget totals/segments, glyph preset completeness (every glyph referenced exists in the active preset; per-preset key parity; `resolvePresetName` table), `hint()` separator join per preset, `stateLine` extraction parity, `previewLine` truth table (live→line · otherwise blank · stale id→blank), ANSI-width helper (strip correctness incl. wide-CJK conservative case).
- Port: `listFleetTodos` round-trip via adapter with a temp fleet dir.
- Integration: real-pi smoke per getpipher rule — run card appears/animates/finalizes in a live term (mock-vs-real trap, dogfood gotcha #9, applies doubly to renderers); timer-leak check (second burst after first completes).
- Gates: `pnpm typecheck` + `pnpm test:run` standalone before every commit (gotcha #10 — never piped).

## 10 · Risks & mitigations

| Risk | Mitigation |
|---|---|
| EditorTheme vs Theme factory arg (v0.2.1 crash class) | Thread `() => ctx.ui.theme` live getter everywhere; no `any` casts; integration smoke inside real pi before ship |
| Renderer exception destabilizes transcript | pi catches per-slot → fallback; still: pure functions, no I/O in renderers, defensive optional-chaining on store reads |
| Timer leak after finalize | `Loader.stop()` called in final render path; leak check in integration smoke |
| ANSI codes break width math (wrap/truncate/alignment) | `width.ts` is a P1 prerequisite, not an afterthought |
| Live re-render cadence surprises (event ticks vs 1s clock) | Documented behavior: transcript animates on invalidate ticks; widget owns the 1s clock; no new long-lived intervals beyond widget's existing one |
| armory-todo coupling drift | Read method lives behind the port; adapter is the only importer (existing insulation) |
| Cross-session dispatch contamination (#102) | Implementation dispatches run sequentially; provenance guard in briefs until #102 closes |
| Adversarial lineage data (cycles, missing parents, self-reference) | `layoutTree` visited-set + orphan top-level + degrade-to-flat; unit-tested in `test/tree.test.mts` |

## 11 · Out of scope (parked / rejected)

- SPEC-6-4 deferred NITs bundle (RunJournal tests, envelope spread hardening, `MetaLike`, `fleetMode` double-default) — separate approval, unchanged.
- Replacing pi's footer/statusline; theme *authoring* (presets of glyphs only, not colors); panel key remaps; engine-visible changes; `resultLanguage` pref (spec N2 of #88, separately parked).
- P3-parked: runtime preset switching (env var is process-scoped by ratification); Runs-view preview row; nerd spinner frame tuning beyond the smoke (data-only swaps).

## Appendix · Before/after mockups (normative visual targets)

Approved by RECTOR 2026-09-03. (ASCII cannot carry color; legends annotate token mapping.)

### Widget

Before — plain strings:
```
▶ "Review PR #102 for the routing regression"  · reviewer  41s  186K tok  18%  $0.11
▶ "Implement totals header"  · implementer  2m3s  412K tok  34%  work  $0.83
⚠ submitting a message aborts the foreground run · r-8f3 · /fleet to inspect
```

After — totals strip + aligned segments (spinner/name=accent, meta=muted, values=text, ↗=dim, stale=warning+bold):
```
⣾ 2 running · $0.94 · 598K tok
├ ⣾ reviewer     41s   ●tool:read   18%  $0.11
├ ⣾ implementer  2m03s ●edit        34%  $0.83  ↗armory-todo
```

### `/fleet` Fleet tab

Before:
```
  FLEET  [fleet] lifecycle runs agents backends scheduled tiers workflows

  ▶ r-8f3  reviewer  running  41s  18% ctx  td-mtjl50  "Review PR #102 for…"
  ▶ r-9a1  implementer  running  2m3s  34% ctx  td-mtjl51  "Implement totals…"
  ✓ r-7c2  general  completed  4m12s  22% ctx  td-mtjh05  "Explore project…"

  r:Run-new  s:Steer  x:Stop  o:Open-todo  tab:Lifecycle  q:Quit
```

After (row glyph=status token; footer capability-aware):
```
  FLEET  [fleet] lifecycle runs agents …        ⣾ 2 running · ✓ 1 done · $1.24 · 268K tok

  ▶ r-8f3  reviewer     41s    ●tool:read  18%  $0.11
  ▶ r-9a1  implementer  2m03s  ●edit       34%  $0.83  ↗armory-todo
  ✓ r-7c2  general      4m12s  ·5t ✎3      22%  $0.30

  ↑↓ select · s steer · x stop · o open-todo · tab lifecycle · q quit
```

### Run card — fire / finalize

At dispatch (live):
```
╭─ ⣾ fleet · reviewer · glm-5.2 ────────────────────────╮
│  task   Review PR #102 for the routing regression      │
│  state  ⣾ tool:read · turn 3 · 41s · 186K tok · 18%    │
╰────────────────────────────────────────────────────────╯
```

Finalized (collapsed; expand = native `app.tools.expand`):
```
╰─ ✓ reviewer · 4m12s · 598K tok · $0.30 · ✎3 · verdict: Ship
```

### Orchestration + TODO tree (live, TUI-only)

Before: nothing renders in-transcript during bg bursts.

After:
```
ⓘ waiting on 3 runs · $0.94 · 598K tok
├ ⣾ reviewer     41s   ●tool:read   18%
├ ⣾ implementer  2m03s ●edit        34%
└ ⏳ scheduler   queued
TODO
├─ SPEC-6-7 panel redesign · 2/5
│  ├ ☑ totals header        → r-8f3 ✓ 4m12s
│  ├ ☑ row color language   → r-9a1 ✓ 6m40s
│  ├ ☐ state-machine footer → ⣾ r-b2c · 41s
│  └ ☐ lineage tree toggle
☾ waiting on gate: review-pass
```

### Findings (burst end, durable)

```
── findings ────────────────────────────────
✓ reviewer     4m12s  598K tok  $0.30 — Ship (1 NIT: ANSI width)
✓ implementer  6m40s  412K tok  $0.83 — committed abc1234, ✎3
✗ scheduler    —      —         —      worker exited without result (TODO reverted ⚠)
⚠ fallback used once: openrouter/z-ai/glm-5.2 (rate-limit)
```

### Timeline scroll separator (P2 — ratified: footer line, ↓ re-follow)

Live run streaming + scrolled up (`pinned === false`) — the footer hint line becomes:
```
  ↑ scrolled · live paused · ↓ end to re-follow
```
(warning-themed; Enter unchanged = Full-message; scrolling back to the newest row re-pins and restores the normal hint)
