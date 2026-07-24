# SPEC-4 — term-driven smoke checklist

Run after publishing `v0.4.0` (install the package into pi, `/reload`).

| # | Row | Action | Expected |
|---|-----|--------|----------|
| 1 | install | add `"npm:@getpipher/armory-fleet@0.4.0"` to `~/.pi/agent/settings.json` packages, `/reload` | pi loads the extension, no EditorTheme crash |
| 2 | /fleet | open panel, `tab` to Lifecycle | Lifecycle tab renders (between Fleet + Agents), empty list (no runs yet) |
| 3 | Run lifecycle | press `r`, type a trivial task, submit; lifecycle name blank→default | row appears with ▶ status, phase advances, phase index N/5 updates |
| 4 | checkpoint | at a checkpoint (brainstorm/plan/review), the `c:Continue v:Revise a:Abort` submenu shows | `c` advances; `v` opens the feedback Input → submit re-runs the phase; `a` reverts the todo + aborts |
| 5 | completion | let it finish | row shows ✓, todo marked done in armory-todo (check `/todo`) |
| 6 | i:Info | select a lifecycle row, press `i` | phase-timeline detail pane renders ([x]/[~]/[ ] markers + artifact paths), `esc` returns |
| 7 | /fleet-implement <task> | run the slash | lifecycle starts, row appears in Lifecycle view, notify on completion |
| 8 | --auto | `/fleet-implement trivial --auto` | runs end-to-end (no checkpoints), ✓ on done |
| 9 | --lifecycle | `/fleet-implement x --lifecycle default` | selects the named lifecycle; bad name → actionable error notify |
| 10 | agent tool | the model calls `subagent({ task, lifecycle: "default" })` | runs end-to-end (auto), returns a phase summary as the tool result |
| 11 | failure | force a failing task (e.g. impossible request) | lifecycle status ✗ failed; todo stays open; row shows ✗ |
| 12 | smoke script | `node --import tsx scripts/spec-4-smoke.mts` | real Ollama pi lifecycle runs end-to-end, `SMOKE PASSED ✅` |

## Notes
- RECTOR's `claude` CLI OAuth is expired — CC-phase backend rows skip gracefully (per the SPEC-3
  smoke pattern); re-auth `claude` first to exercise a per-phase `backend: claude` lifecycle.
- The Lifecycle view is a `ctx.ui.custom()` panel → threads the factory `Theme` arg; the
  EditorTheme gotcha (§9.5) is a `setEditorComponent` concern and does not bite the read-only
  lifecycle view. A live-theme-switch mid-panel is a refinement (recorded); the panel caches
  `theme` from the factory, which is fine for v0.4.