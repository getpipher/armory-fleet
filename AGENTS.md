# @getpipher/armory-fleet — project context

> **Status:** 🚧 Pre-implementation. Master PRD written + self-reviewed (2026-07-23); SPEC-1 brainstorm is next.
> **Package:** `@getpipher/armory-fleet` · npm org `getpipher` (account `rz1989`) · MIT.
> **Compatibility:** pi `^0.81.1`.

## What this is

The armory suite's subagent orchestrator for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — a cross-harness, superpowers-native fleet where every agent is **armory-native from birth** (syncs to armory-todo, hydrates from armory-memory, sees via vision, edits via cursor — all by default). Goal: be the best pi-subagent package in the ecosystem. Full vision, spine, scope, and the 7-SPEC roadmap live in [`PRD.md`](./PRD.md).

## Pipeline

PRD (master) → each SPEC-N gets its **own** brainstorm → spec → plan → implementation cycle. **Do NOT jump to writing-plans from the PRD.** Brainstorm the SPEC first, mirroring how the PRD was produced.

The 7 SPECs (see PRD §8):
1. Core engine + armory-todo sync
2. Deep armory integration (memory/vision/cursor)
3. Cross-harness peers (CC + Pi)
4. Superpowers-native lifecycle
5a. Operational runtime (async/scheduling/worktree)
5b. Fleet TUI (FleetView/widget/steering)
6. Power-user tier → v1.0 (cost-aware tiers, quality gates, workflows-as-code, RPC)

## Conventions

- Raw `.ts` via tsx at runtime (**no build step**); `pnpm typecheck` + `pnpm test:run` (node:test via tsx) before release.
- Publish via CI on `v*` tag using the getpipher `NPM_TOKEN` org secret; `release.yml` mirrors armory-todo (idempotent npm publish + GitHub Release step).
- Interactive-first UX: every capability lands as a `/fleet` panel tab/view + action-submenu entry FIRST, then the model-callable tool action (per `~/local-dev/getpipher/AGENTS.md`).
- Vendored MIT commodity plumbing (worktree/scheduling/graceful-turns/queue) lives in `src/vendor/<source>/` with a per-module `NOTICE.md` crediting origin + license; frozen + attributed + swappable.

## Architecture pointers

- **Engine primitive:** `createAgentSession()` from `@earendil-works/pi-coding-agent` SDK (child Pi sessions, in-memory or file-backed `SessionManager`, `ResourceLoader`).
- **Extension surface:** `pi.registerTool`, `pi.registerCommand`, `pi.events`, `pi.exec`, custom UI (`ctx.ui.custom`, widgets/footer/overlay/custom-editor/autocomplete), message/entry renderers.
- **EditorTheme gotcha** (caused the v0.2.1 cursor crash): `ctx.ui.custom((tui, theme, kb, done) => …)` receives the full `Theme`; `ctx.ui.setEditorComponent((tui, theme, kb) => …)` receives `EditorTheme` (only `{borderColor, selectList}`). For real theme colors thread `() => ctx.ui.theme` (live getter), never the factory `theme` arg. See `~/local-dev/getpipher/AGENTS.md`.
- **pi docs:** `~/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (`extensions.md`, `sdk.md`, `rpc.md`, `sessions.md`).

## References

- Master PRD: [`./PRD.md`](./PRD.md)
- Landscape research: [`./research/`](./research) — `LANDSCAPE.md` + 5 contender READMEs
- Sibling ecosystem: [armory-todo](https://github.com/getpipher/armory-todo), [armory-memory](https://github.com/getpipher/armory-memory), [vision](https://github.com/getpipher/vision), [cursor](https://github.com/getpipher/cursor)