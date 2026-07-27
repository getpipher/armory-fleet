# SPEC-5b-3 — Term-smoke checklist (published @0.8.0)

> **Flow correction (carried from 5b-2):** pi auto-reinstalls npm packages on launch → branch code
> can't be smoked directly (local symlinks get clobbered). Unit tests + typecheck gate the branch;
> the **term smoke runs on the PUBLISHED version**. So: bump version → tag `v0.8.0` → push →
> Release CI publishes → bump `settings.json` → relaunch pi → smoke published. (The 5b-1/5b-2
> proven flow.)

## Branch gate (done before publish)
- [x] `pnpm typecheck` clean.
- [x] `pnpm test:run` — 303/303 pass (289 + 14 conversation-rows).
- [x] `package.json` version → `0.8.0`.

## Publish
- [ ] `git push -u origin feat/spec-5b-3-conversation-viewer`.
- [ ] `git update-ref refs/tags/v0.8.0 HEAD` + `git push --force origin v0.8.0`.
- [ ] Release CI publishes → `npm view @getpipher/armory-fleet version` = `0.8.0` + `gh release view v0.8.0`.
- [ ] `~/.pi/agent/settings.json`: bump `@getpipher/armory-fleet` → `@0.8.0`.

## Term smoke (on published @0.8.0, via `term` tmux harness)

Fresh temp cwd — NOT a real repo (the v0.5.1 foreground-subagent isolation caveat):

1. `mkdir -p /tmp/fleet-5b3-smoke && cd /tmp/fleet-5b3-smoke && git init -q` → spawn `pi` in tmux.
2. Delegate a foreground subagent that produces **≥1 assistant message + ≥1 tool call** and completes in ~10s (e.g. "read this file and summarize it" → a `read` tool event + an assistant message). Wait for completion.
3. Open `/fleet` → tab to `runs` → `enter` on the completed run → **timeline** renders with `[a]`/`[t]` rows.
4. **Timeline interactivity (5b-3 fix — v0.6.0 was display-only):** press Down/Up → the `→` selection marker moves across rows.
5. **Full-message overlay on a message row:** arrow to a `[a]` row → `Enter` → timeline replaced by `── assistant · turn N · M tok ──` + the **full** assistant text (multi-line, scrollable). `Esc` → back to timeline, cursor **on the same `[a]` row** (selection restored).
6. **Full-message overlay on a tool row:** arrow to a `[t]` row → `Enter` → `── tool: <name> · turn N · ✓/✗ · args/result excerpted ──` + `args:` + indented args + `result:` + indented result (errors in-full). `Esc` → back to timeline, cursor restored.
7. **State hygiene:** `Esc` from timeline → back to Runs list; tab away → overlay state cleared (no stale overlay).
8. Use `send` for literal letters, `sendKey` ONLY for Enter/Escape/Tab/Up/Down (5b-1 `r`/`f` lesson).
9. **Restart pi in the same cwd** → Runs tab still shows the run (5b-1 restart-safety); open timeline → still navigable.

## Gates
- Loader accepts `@0.8.0:src` (no crash on launch).
- Timeline scrolls (the 5b-3 interactivity fix verified live).
- Full-message overlay opens on both message + tool rows; esc restores the timeline cursor.
- No stale overlay after tab switch / restart.

## Carry-forward lessons applied
- `send` for letters, `sendKey` for named keys.
- `git update-ref` lightweight tag (not `git tag -a` — Vim hangs the non-interactive bash).
- Publish-then-smoke (not smoke-branch-then-publish).
- `FleetPanel` class isn't unit-tested — the term smoke is the gate for panel/overlay interaction.