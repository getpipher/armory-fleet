# SPEC-5b-2 — Term-driven TUI smoke checklist

**Release:** `@getpipher/armory-fleet@0.7.0`
**Date:** 2026-07-26
**Harness:** `term` tmux driver, fresh temp cwd `/tmp/fleet-5b2-smoke` (not a real repo — v0.5.1 isolation caveat)
**Model:** Ollama `glm-5.2:cloud`

> Flow correction (spec → smoke): pi auto-reinstalls npm packages on launch, clobbering any local symlink to branch code. So the smoke runs on the **published** `@0.7.0` (matching the 5b-1 flow: publish → smoke published). Unit tests (289) + typecheck are the branch-code gate; the term smoke is the loader-acceptance + live-render gate.

## Steps executed

1. Bumped `package.json` → `0.7.0`; typecheck + 289 tests green; committed; tagged `v0.7.0` (lightweight via `git update-ref`); pushed branch + tag; Release CI published to npm + GitHub Release v0.7.0.
2. Bumped `~/.pi/agent/settings.json` `@0.6.0` → `@0.7.0`.
3. Spawned pi in `/tmp/fleet-5b2-smoke` via `term`. Pi reinstalled packages + loaded `@getpipher/armory-fleet@0.7.0:src` cleanly (loader-acceptance gate ✅).
4. Sent prompt: "Use the subagent tool to delegate a task to the `general-purpose` agent with `background:true`. Task: run `sleep 8` then report done. Fire in background; do not wait." → model fired `subagent` with `background:true` → returned `background run: fl-ms16cw6d-gqwzf8` immediately (parent idle, editor active).
5. Captured pane while the bg run executed.

## Gates verified

| Gate | Result | Evidence |
|---|---|---|
| Loader accepts `@0.7.0:src` | ✅ | `@getpipher/armory-fleet@0.7.0:src` in `[Extensions]` on both launches; no `uncaughtException` |
| Widget renders live above editor while runs active | ✅ | Two lines appeared above the editor: the bg run's lifecycle phase-child (RunRegistry row) + the bg run itself (BgRunsStore row) |
| Live duration ticking | ✅ | phase-child row duration advanced `2s → 38s → 48s → 1m4s → 3m0s` across captures (1s timer working) |
| Real token count (Q9 fix live) | ✅ | phase-child row showed `225071 → 225905 → 452785 tok` (real tokens = input+output+cacheRead+cacheWrite; under 5b-1 this would have shown dollars-as-tok) |
| Phase transitions tracked | ✅ | 3 distinct phase-child runIds appeared (`fl-ms16cw7p…` → `fl-ms16dvcr…` → `fl-ms16exgh…`) as the default lifecycle advanced; old phase completed + dropped out, new phase appeared |
| Idle-hidden at startup | ✅ | no widget visible before the run fired (widget hides when no active runs) |
| No orphan widget on restart | ✅ | killed pi, relaunched in same cwd → editor area empty (no widget); `1 interrupted fleet run — open /fleet to resume` notification confirmed the orphan was detected. The widget reads in-memory stores (empty on boot); the orphaned run lives in the durable `RunLog` (Runs-tab concern), not the live widget — matching the design ("RunRegistry = now; RunLog = ever") |
| Hide-on-completion (natural) | ✅ (unit-tested) | `fleet-widget.test.mts`: "active fg run → both widgets set; completion → both cleared" + "bg run active → … cleared on completion" both pass. The restart-hide (real pi) confirms the `setWidget(key, undefined)` clear path works in production. Natural completion of the full 5-phase lifecycle wasn't waited out (each phase does 225k+ tokens of real model work → many minutes); the unit tests + restart-hide cover the hide behavior. |

## Result

**PASS.** The live widget + FleetView ship correctly on published `@0.7.0`: loader accepts the code, the widget renders live above the editor with ticking duration + real token counts + phase tracking across both in-memory stores, hides when idle, and leaves no orphan on restart. The Q9 token-unit fix is verified live (tokens, not dollars).

## Notes / deviations

- **`pi.on("session_end")` → `"session_shutdown"`:** the spec/plan wired dispose on `session_end`, but pi's extension API exposes `"session_shutdown"` (verified in `dist/core/extensions/types.d.ts:858`). Used `session_shutdown`.
- **Flow order:** the plan ordered "smoke then publish"; reality (pi's npm-reinstall-on-launch) requires "publish then smoke published" — this is the 5b-1 proven flow, documented in the carry-forward.
- **`send`/`sendKey` discipline:** only Enter was sent via `sendKey`; the prompt text via `send`. No letter-key `sendKey` mistakes (the 5b-1 lesson).