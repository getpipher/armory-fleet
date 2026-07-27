# SPEC-5b-3 — Conversation viewer (full-message overlay)

**Date:** 2026-07-26
**Sub-SPEC of:** SPEC-5b (Fleet TUI)
**Package:** `@getpipher/armory-fleet` · target release `0.8.0` (minor)
**Predecessors:** SPEC-5b-1 (v0.6.0 — `RunLog` + Runs tab + timeline overlay with `enter` placeholder); SPEC-5b-2 (v0.7.0 — live widget + FleetView + token-unit fix)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context

SPEC-5b-3 is the third sub-SPEC of SPEC-5b (Fleet TUI). It delivers the **conversation viewer** — a full-message overlay that makes a run's journaled conversation fully readable instead of the one-line excerpts the 5b-1 timeline shows. It is the lowest-risk sub-SPEC of 5b: a pure read-side overlay over `RunLog.replay` data already shipped in v0.6.0. No new live seam, no new store, no timer, no journal change.

### The gap 5b-3 closes
- The 5b-1 Runs-tab timeline shows one **excerpted** line per event: assistant text truncated to 80ch, tool `args`/`result` to one line each. A user who wants to read the full assistant message or a tool's complete result has to leave the TUI and `cat`/`grep` the `.pi/fleet/runs/<runId>.jsonl` file.
- 5b-1 explicitly reserved the timeline `enter` key as a no-op placeholder for this overlay (5b-1 §5: "enter on a timeline row = no-op placeholder for 5b-3"; the rendered hint literally reads `enter: (5b-3 full message)`).

5b-3 swaps that placeholder for a second overlay level: timeline row `enter` → a scrollable full-message view of that one event; `esc` → back to the timeline with the cursor restored.

### Journal fidelity (settled in brainstorm, Q2=C)
`MessageEvent.text` is already the **full** assistant text (5b-1 Q1 chose "assistant text full"). Only tool `args`/`result` are excerpted in the journal (5b-1's deliberate curation: `excerpt(args, 200)`, `excerpt(result, 500)`, **errors in-full**). 5b-3 is a pure overlay: messages show truly-full text; tools show the full-as-journaled excerpt (which for errors is already the complete result). The overlay header for a tool event notes "args/result excerpted" so the asymmetry is honest, not hidden. Widening the journal to truly-full tool I/O is a 5b-1-amendment or SPEC-6 storage-tier decision — out of 5b-3 scope.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| Q1 | Overlay interaction structure | **A — second overlay level**: timeline `enter` → full-message view **replaces** the timeline; `esc` → back to timeline with selection restored. Stack: Runs list → timeline → full message. Reuses the 5b-1 overlay-replaces-overlay pattern verbatim. |
| Q2 | Journal fidelity ("full" meaning) | **C — hybrid, no journal change**: messages truly-full (already stored full); tools full-as-journaled excerpt (errors in-full); tool header notes "args/result excerpted". No `RunLog`/`spawnSubagent`/storage change. |
| Q3 | Rendering + scroll for long content | **A — SelectList of wrapped lines**: pure `wrapToLines(text, width): string[]` produces one-line rows; body is a `SelectList` (same widget + theme callbacks + `maxVisible:12` as the timeline). Header is a `Text` above, mirroring the timeline header. No new pi-tui primitives. |
| Q4 | Replay-only vs live-scrolling | **A — replay-only**: pure overlay over `RunLog.replay(runId)`; no new live seam. Live-scrolling deferred to 5b-4/SPEC-6 where it pairs with mid-run steering. |

## 3. Architecture

One new overlay level on top of the 5b-1 timeline, inside the same `ctx.ui.custom` Container. Two new FleetPanel state fields. One new pure-renderer module. No store, seam, timer, or journal change.

```
Runs list (5b-1)
  └─ enter/i on a run → timeline overlay (5b-1)
       │ SelectList rows: value=String(idx), label=runTimelineRow(e)
       │                onSelect → opens full-message overlay
       └─ enter on a timeline row → full-message overlay (5b-3, NEW)
            │ header Text: messageHeader(e) | toolHeader(e)
            │ body SelectList: wrapToLines(text) | toolBody(e)
            └─ esc → back to timeline (selection restored via setSelectedIndex)
```

**No changes to:** `RunLog`, `spawnSubagent`, `RunRegistry`, `BgRunsStore`, the write path, the live widget (`FleetWidgetController`), or any store. Pure read-side overlay.

## 4. Components

### New: `src/panel/conversation-rows.ts` — pure renderers (unit-tested)
- `wrapToLines(text: string, width: number): string[]` — word-wrap to `width` cols; long tokens (no break opportunity) hard-split at `width`; preserves intentional `\n` as row breaks (multi-line tool results); empty input → `[""]`; `width ≤ 0` → `[""]` (defensive). Pure, no theme.
- `messageBody(e: MessageEvent, width: number): string[]` — `wrapToLines(e.text, width)` (the full assistant text).
- `toolBody(e: ToolEvent, width: number): string[]` — `["args:", …wrapToLines(e.args, width-2) indented 2sp, "result:", …wrapToLines(e.result, width-2) indented 2sp]`. Errors already in-full in the journal.
- `messageHeader(e: MessageEvent): string` — `── assistant · turn N · M tok ──`; omits `· M tok` when `e.usage?.total` absent.
- `toolHeader(e: ToolEvent): string` — `── tool: <name> · turn N · ✓/✗ · args/result excerpted ──`.
- All pure, no theme arg (codebase convention from `widget-rows.ts`/`runs-rows.ts`).

### Changed: `src/panel/fleet-panel.ts`
- New private fields: `selectedEventIndex: number | null = null` + `fullMessageEvent: MessageEvent | ToolEvent | null = null`.
- Timeline `SelectList` rows: `value: String(idx)` (was `""`); `label` unchanged (`runTimelineRow(e)`). Wire `tl.onSelect = (item) => { const idx = Number(item.value); const ev = timelineEvents[idx]; if (!ev) { this.deps.onNotify("event no longer available", "warning"); return; } this.selectedEventIndex = idx; this.fullMessageEvent = ev; this.renderShell(); }`. Hint text `enter: (5b-3 full message)` → `enter:Full-message  esc:Back`.
- New render branch at the **top** of the cascade (before `this.selectedRun`): when `this.fullMessageEvent` is set → render header `Text` + body `SelectList` (`messageBody`/`toolBody` rows, `maxVisible: 12`, same theme callbacks as the timeline) + footer `Text` `esc:Back`.
- Keypress handler: new `if (this.fullMessageEvent)` branch **before** the `selectedRun` branch — `escape` → `fullMessageEvent = null` + `selectedEventIndex = null` + `renderShell()` (timeline re-renders; selection restored via `setSelectedIndex`). `enter` is consumed by the body `SelectList`'s own `handleInput` (no-op — a text line has nothing to drill into); the panel handler does not act on `enter` here.
- Timeline restore: when the timeline `SelectList` is re-created on re-render (5b-1 re-creates it each render), call `setSelectedIndex(this.selectedEventIndex ?? 0)` if `selectedEventIndex != null`, then clear `selectedEventIndex` (the restore is one-shot).
- `reset()` (called on tab switch / `q`): clears `fullMessageEvent` + `selectedEventIndex` alongside `selectedRun`/`runTimeline`.
- Footer hint: when `fullMessageEvent` active → `esc:Back`; when `selectedRun` active (timeline) → `enter:Full-message  esc:Back` (was `enter:(5b-3)  esc:Back`).

### Not changed
- `src/panel/runs-rows.ts` — timeline rows unchanged; the excerpt policy is documented in the overlay header, not the row.
- `src/runtime/run-log.ts` — no change (Q2=C).
- `src/engine/spawnSubagent.ts` — no change.
- Everything else.

## 5. Data flow

```
Runs tab, timeline open, row selected, press enter
  → tl.onSelect(item) → selectedEventIndex = Number(item.value)
                        fullMessageEvent = timelineEvents[idx]
                        renderShell()
  → render cascade: fullMessageEvent != null (top of cascade)
       → header Text: messageHeader(e) | toolHeader(e)
       → body SelectList: messageBody(e, width) | toolBody(e, width)  (maxVisible 12)
       → footer Text: "  esc:Back"
  → esc → fullMessageEvent = null; selectedEventIndex = null; renderShell()
           → timeline re-renders; setSelectedIndex(restoreIdx) restores cursor; restoreIdx cleared
```

**Event snapshot semantics:** `timelineEvents` is the `runTimeline` filtered to message/tool events (5b-1's existing filter), captured at timeline-open time from `runLog.replay(runId)`. The overlay indexes into this snapshot — it does NOT re-read the journal on `enter` (replay-only, Q4=A). A running run's timeline, once open, is static until `esc`→re-open or a store-change-triggered re-scan (5b-1's live-refresh).

## 6. Error handling

| Failure | Behavior |
|---|---|
| `timelineEvents[idx]` out of range (snapshot mutated between open + enter) | `onSelect` guarded → `onNotify("event no longer available", "warning")`; no overlay. Cannot happen in practice (snapshot is immutable) but defensive. |
| Empty event text (assistant `""`) | `wrapToLines("", width)` → `[""]` → body shows one blank row. Honest, no crash. |
| `usage.total` absent (backend omits usage) | `messageHeader` omits the `· M tok` segment (cosmetic). |
| Body `SelectList` `enter` | no-op (a text line has nothing to drill into); swallowed by `SelectList.handleInput`. |
| Tab switch / `q` while overlay open | `reset()` clears `fullMessageEvent` + `selectedEventIndex` + `selectedRun` + `runTimeline`. |
| `runLog` absent (unit tests) | timeline never opens (5b-1 guard) → overlay unreachable. |
| Key-routing: panel catches `enter` while body list active | The body `SelectList.handleInput` consumes `enter` before the panel handler (same split as 5b-1 timeline); panel's `fullMessageEvent` branch only acts on `escape`. Verified in the plan. |

## 7. Testing

**Unit tests (node:test via tsx) — the fast gate:**
- `conversation-rows.test.mts` — `wrapToLines` (plain wrap, long-token hard-split, CJK/long-line overflow, `\n` preservation, empty → `[""]`, `width ≤ 0` → `[""]`); `messageBody`/`toolBody` shape (args:/result: labels, 2sp indent); `messageHeader`/`toolHeader` (with/without `usage.total`; ✓/✗ glyph; "args/result excerpted" present on tool header, absent on message header).
- `panel-conversation.test.mts` — extend the `panel-runs.test.mts` harness: open timeline (`enter`/`i` on a run) → `enter` on a timeline row → assert full-message overlay renders header + body rows from the fixture's events; `esc` → back to timeline with selection restored (`setSelectedIndex` called with the prior index); `reset()` on tab switch clears `fullMessageEvent` + `selectedEventIndex`. Reuses the existing fake `deps` + `runLog` fixture pattern.

**Term-driven TUI smoke (the gate, per 5b-1/5b-2 carry-forward):** fresh temp cwd (not a real repo — the v0.5.1 isolation caveat), run a foreground subagent that produces ≥1 assistant message + ≥1 tool call; open `/fleet` → tab to `runs` → `enter` on the run → timeline → `enter` on a message row → full assistant text visible + scrollable; `esc` → back to timeline, cursor on the same row; `enter` on a tool row → args + result visible (result in-full for errors); `esc` → back to timeline; `esc` → back to Runs list. Use `send` for literal letters, `sendKey` ONLY for named keys (the 5b-1 `r`/`f` lesson). Gate the release on this, not just unit tests (the tsx-masks-loader caveat).

**No new external deps. No vendored plumbing. No build step. No journal change.**

**~+18 tests on top of 289. typecheck clean. Release `@getpipher/armory-fleet@0.8.0`** (minor: new conversation overlay; no breaking API — pure read-side addition).

## 8. Scope boundaries (anti-gold-plating)

**In 5b-3:** full-message overlay (second level), `wrapToLines` + `messageBody`/`toolBody` + `messageHeader`/`toolHeader` renderers, timeline `onSelect` wiring + selection restore, unit + term smoke.

**Deferred:**
- Live-scrolling (Q4=A — 5b-4/SPEC-6, pairs with mid-run steering).
- Truly-full tool I/O (Q2=C — journal stays curated; widening is a 5b-1-amendment or SPEC-6 storage-tier decision).
- Fleet-tab `enter` → conversation (second entry point; gold-plating for 5b-3; the Runs tab is the conversation entry point).
- In-overlay search / copy (shell `grep` over `.pi/fleet/runs/` works; YAGNI).
- Per-turn grouped view (one row per turn instead of per-event) — 5b-1's per-event timeline granularity is the contract.
- Syntax highlighting / markdown rendering of assistant text (plain wrapped text in 5b-3).

## 9. Risks

- **Key-routing between panel + SelectList:** the timeline's `enter` is consumed by `SelectList.handleInput` → `onSelect`; the panel handler must NOT also act on `enter` when the timeline is active. 5b-1 already has this split (panel catches `esc`, list catches `enter`); 5b-3 mirrors it for the body list. The plan verifies the exact `handleInput` ordering in `fleet-panel.ts`'s `onInput`.
- **Selection restore on `esc`:** the 5b-1 code re-creates the timeline `SelectList` each render, so restore = re-create then `setSelectedIndex(storedIdx)`. `selectedEventIndex` is the restore source; it's cleared only after `setSelectedIndex` is called (one-shot). If `setSelectedIndex` clamps out-of-range indices, `?? 0` is the safe fallback.
- **`width` for wrapping:** the `ctx.ui.custom` factory's `tui` exposes terminal width; the body `SelectList` already renders at that width. If the exact width isn't reachable from the render branch, fall back to a constant (e.g. 80) with a unit-test note. Resolved in the plan.
- **Overlay state leak across tab switches:** mitigated by `reset()` clearing the two new fields. The unit test asserts the clear.

## 10. References
- PRD §8 (SPEC-5b line), §5 (interactive-first panel), §7 (architecture foundation)
- SPEC-5b-1 (`docs/superpowers/specs/2026-07-25-spec-5b-1-design.md`) — the `RunLog` + Runs tab + timeline overlay with `enter` placeholder that 5b-3 extends
- SPEC-5b-2 (`docs/superpowers/specs/2026-07-26-spec-5b-2-design.md`) — carry-forward conventions (pure render fns, term-smoke gate, publish-then-smoke flow)
- `src/runtime/run-log.ts` — `replay(runId): RunLogEvent[]`, `MessageEvent` (full `text`), `ToolEvent` (excerpted args/result, errors in-full)
- `src/panel/fleet-panel.ts` — the `selectedRun`/`runTimeline` overlay state + render cascade + keypress handler 5b-3 extends
- `src/panel/runs-rows.ts` — `runTimelineRow(e)` (unchanged)
- pi-tui `SelectList` API: `onSelect(item)`, `onSelectionChange(item)`, `getSelectedItem()`, `setSelectedIndex(i)`, `SelectItem.value` (`select-list.d.ts`)
- getpipher conventions: `~/local-dev/getpipher/AGENTS.md` (interactive-first, EditorTheme gotcha, no AI attribution, `--test-timeout=30000` in `test:run`)