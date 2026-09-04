# Implementation Plan — P2 verification & closure (the 8 counted tasks are landed; this covers the proof + the reserved remainder)

> **For agentic workers:** This is a VERIFICATION-and-CLOSURE plan, not a feature plan. `docs/superpowers/plans/2026-09-03-fleet-presentation-p2.md` (the counted artifact) is itself the implementation plan, and branch `feat/104-fleet-presentation-p2` already carries all 8 tasks as commits (ledger below — verified via `git log --oneline main..HEAD`). What remains: an objective landed-vs-plan audit, the final gates, the controller-reserved real-pi smoke, and ship. Steps 1-3 are executor-safe (read-only + tests); Steps 4-5 are CONTROLLER-HELD (push/PR/workflow).

**Ground truth:** base `d9345bb` (P1 merge #109) → head `cd28505`. Suite: 919/919, typecheck 0 (last full run at cd28505). Defect-4 (`finalLine` raw-status throw) was reproduced by smoke and fixed in `cd28505`.

## Landed-state ledger (verified on branch)

| Plan task | Commit(s) | Artifacts on branch |
|---|---|---|
| 1 layoutTree | `d31a241` | `src/present/tree.ts` + `test/tree.test.mts` |
| 2 card geometry/CARD_WIDTH | `2c575fe` | `src/transcript/run-card.ts` (CARD_WIDTH, empty-segment suppression) + tests |
| 3 renderCall delegation | `f3895b3` | `src/tools/subagent.ts` renderCall → liveCardLines |
| 4 Runs tree (t toggle) | `6dba931` | `runsRow` prefix, `buildItems()`, `treeByView`, `t` handler, VIEW_HINTS |
| 5 Fleet tree (childRunIds) | `49c1daa` + `a1e0f0a` (review fix: visible-claims intersect) | `buildFleetItems` workflowRuns/tree + ghost-row/partial-count pins |
| 6 Panel real-width | `0603734` | `render(width)` capture, `totalsHeader`, overlay floor 40 |
| 7 Scroll separator | `37cca64` | `timelineFooter` + detached wiring |
| 8 Acceptance/docs (partial) | `f74aed2` | journal-lineage acceptance test, README P2 line, ledger; smoke + PR controller-reserved |
| smoke defect fix | `cd28505` | `finalLine` → statusToken (Unknown-theme-color throw) |

---

### Task A: Landed-vs-plan audit (read-only)

- [ ] For each of the 8 plan tasks, verify the named artifacts exist and their named tests are present:
```bash
ls src/present/tree.ts src/present/tokens.ts src/present/width.ts src/transcript/run-card.ts src/transcript/render-state.ts src/transcript/findings.ts src/transcript/orchestration.ts src/panel/present.ts
grep -l "layoutTree" src/panel/fleet-panel.ts src/panel/fleet-items.ts
grep -n "CARD_WIDTH" src/transcript/run-card.ts src/tools/subagent.ts
grep -c "prefix = \"\"" src/panel/runs-rows.ts
grep -n "workflowRuns" src/panel/fleet-items.ts | head -2
grep -n "totalsHeader\|timelineFooter" src/panel/present.ts
ls test/tree.test.mts test/present-tokens.test.mts test/present-width.test.mts test/present-glyphs.test.mts test/transcript-run-card.test.mts test/render-slots.test.mts test/transcript-findings.test.mts test/transcript-orchestration.test.mts test/widget-segments.test.mts test/panel-present.test.mts
```
- [ ] Verify NO `width = 80` remains in src: `grep -rn "width = 80" src/` → empty.
- [ ] Verify NO raw-status theme.fg in finalLine: `grep -n "theme.fg(s.status" src/transcript/run-card.ts` → empty.
- [ ] Verify emoji purge holds: `git grep -n "✅\|⛔" -- src/` → empty.

**Verify:** every command above returns the expected shape; any miss = a plan-task regression to file before ship.

### Task B: Final gates (standalone, never piped)

- [ ] `pnpm typecheck` → 0 errors.
- [ ] `pnpm test:run` → fail 0 (919/919 at last run; count may grow only via Task A fixes).

**Verify:** both exit 0.

### Task C: CONTROLLER-HELD — real-pi smoke (Task 8 Step 2, tmux + `term` tool)

- [ ] Dispatch a subagent: unified card at dispatch (no missing bar / stray fragment), live state line, collapse to `╰─ ✓ …` final line — **confirm defect-4 stays fixed post-`cd28505`** (final line renders; no bare `subagent` fallback row).
- [ ] Second dispatch at a different terminal width: card geometry identical (CARD_WIDTH clamp).
- [ ] `/fleet` → Runs → `t` twice (grouping on/off, cursor preserved); Fleet → `t`; footer shows `t:Tree` in runs+fleet only.
- [ ] Live timeline on a running run: scroll up → warning detach marker; scroll to end → dim hints return, live resumes.
- [ ] Full-message overlay at ≥100 cols: wraps at real width.
- [ ] Record pass/fail per item in `.superpowers/sdd/progress.md`. Failure → fix branch-side before Task D.

### Task D: CONTROLLER-HELD — ship

- [ ] `git push -u origin feat/104-fleet-presentation-p2`
- [ ] PR to `main`: title `feat: fleet presentation P2 — lineage tree, real-width panel, scroll separator, #108 card fixes`; body = this ledger + smoke evidence + `#108`/`#104` closures.
- [ ] RECTOR review → merge `--merge --delete-branch`.

---

## Execution constraints

- Steps A-B: any executor. Steps C-D: controller only (tmux harness, push, PR).
- No new source changes in this plan — a Task A miss reopens the specific plan task, not a new work stream.
- English; no AI attribution; read-only until Task C/D (controller).
