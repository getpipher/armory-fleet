# SPEC-5b-1 Smoke Checklist (term-driven TUI)

**Gate:** must pass BEFORE tagging v0.6.0. Fresh temp cwd (NOT a real repo — the v0.5.1
foreground-subagent isolation caveat: child tool I/O runs in the parent SHELL cwd).

## Setup
- [ ] Fresh temp dir: `mkdir -p /tmp/fleet-5b1-smoke && cd /tmp/fleet-5b1-smoke && git init`
- [ ] pi installed at `@getpipher/armory-fleet@<pre-release>` (local link or published canary)
- [ ] `~/.pi/agent/settings.json` packages points at the new version

## Smoke steps
- [ ] Launch pi in the temp cwd; confirm extension loads cleanly (no "Cannot find module" / require errors)
- [ ] `/fleet` opens the panel; `tab` to `[runs]` — shows "(empty)" (no runs yet)
- [ ] Run a foreground subagent (model-invoked or `/fleet` → agents → r:Run with task "smoke task")
      — wait for completion
- [ ] `/fleet` → `[runs]` — the completed run appears with `✓ fl-…  agent  …s  … tok  "summary"`
- [ ] `enter` on the run — timeline overlay opens, shows `[a] …` + `[t] …` rows, scrollable
- [ ] `esc` closes the overlay, back to Runs list
- [ ] `r` on the run (with backendSessionId) — "follow-up>" input opens; type a follow-up; submit
      — a new run starts; when done, the Runs list shows it with `← resumed:fl-…`
- [ ] `f` on a completed run — task input opens; submit — a new run starts; Runs list shows `← forked:fl-…`
- [ ] **Restart pi in the SAME cwd** — `/fleet` → `[runs]` — the runs from before are STILL listed (restart-safety)
- [ ] A run that was killed mid-flight (open another pi, start a run, `kill -9` the pi process, restart)
      → on restart, `reconcileRuns` marks it `aborted` (notify fires); Runs tab shows `✗ … "process-gone"`

## Pass criteria
- [ ] All above checked
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test:run` green (247 prior + ~30 new = 274)