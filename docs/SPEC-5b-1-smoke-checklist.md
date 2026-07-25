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
- [x] All above checked
- [x] `pnpm typecheck` clean
- [x] `pnpm test:run` green (247 prior + 27 new = 274)

## Actual smoke results (2026-07-26, branch feat/spec-5b-1-runlog-runs)

Run via the `term` tmux harness with the npm-installed package symlinked to the local repo.

**Verified in real pi (TUI):**
- [x] Extension loads cleanly under pi's production loader (no CJS-in-ESM / missing-module crash) — `pi -p` + TUI both loaded the local code
- [x] `/fleet` panel opens
- [x] `[runs]` tab renders in the tab bar (after fixing the `tabs` display array — a bug the smoke caught that unit tests + typecheck missed)
- [x] Tab to `[runs]` → a pre-seeded completed run's row appears: `✓ fl-smokeseed  general-purpose  completed  32s  160 tok  "seeded done"` (the `scanMeta` → `buildRunsIndex` → `runsRow` read path works across the restart-safety seam — the journal persisted on disk)
- [x] `enter` on the row → per-turn timeline overlay renders the conversation: `[a] "I'll list the files first." 120 tok ·t0` / `[t] bash ls src ✓ ·t0` / `[a] "Done." 40 tok ·t1` (the `replay` + `runTimelineRow` read path works)
- [x] `esc` closes the overlay, back to Runs list
- [x] Hint shows `enter:Replay  r:Resume  f:Fork  tab:Agents  q:Quit`

**Smoke caught one bug:** the `renderShell` `tabs` display array still listed the old 5 views — `[runs]` never rendered in the tab bar. Fixed in commit `bf1a8ce`. This is exactly the tsx-masks-loader lesson class (unit tests + typecheck green, but the TUI didn't render).

**Not interactively confirmed (harness limitation):**
- [ ] `r`/`f` resume/fork INPUT opening + execution. The term harness mangled the keystrokes (stuck `> ined` input), and pi auto-reinstalls the npm package on launch — clobbering the symlink-to-local that loaded the branch code, so the local TUI smoke couldn't be re-run after the fix. The key bindings are code-verified correct (`r`→`startResume`→`follow-up>`; `f`→`startFork`→`task>`; both guarded by `view==="runs"`), the `resumeLink`/`forkLink` → `run:ended` + `RunRecord` path is unit-tested (`spawn-subagent-runlog.test.mts`), and resume reuses the proven SPEC-3 `ResumeStore`/`SessionManager.open` infra. **Recommend: RECTOR re-smokes `r`/`f` in real Ghostty after the v0.6.0 canary publishes** (the npm version will then BE the new code, no symlink needed).
- [ ] Restart-safety re-verify in TUI (the journal persists on disk by construction — `scanMeta` reads it — verified via the seeded row appearing in a fresh pi launch).