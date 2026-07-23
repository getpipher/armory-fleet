# PRD — `@getpipher/armory-fleet`

> **Status:** DRAFT (brainstorming output, pre-spec) · **Owner:** RECTOR · **Created:** 2026-07-23
> **Package:** `@getpipher/armory-fleet` · **npm org:** getpipher (account `rz1989`) · **Repo:** `getpipher/armory-fleet` (created during SPEC-1 implementation)
> **Compatibility target:** pi `^0.81.1` (newer than every contender's target)
> **Pipeline:** PRD (this) → SPEC-N (each its own brainstorm → spec → plan → implementation) → v1.0

---

## 1. Vision

**One-liner:** The armory suite's subagent orchestrator — a cross-harness, superpowers-native fleet where every agent is *armory-native from birth*.

`@getpipher/armory-fleet` brings Claude-Code-style autonomous sub-agents to pi, built so that the armory ecosystem (armory-todo, armory-memory, vision, cursor) is the *default substrate* agents run on — not a bolt-on. It is designed to be the best pi-subagent package in the ecosystem: owning the dimensions competitors structurally cannot, while reaching parity-or-better on the rest.

## 2. The North-Star Spine — the uncopyable moat

Agents are **armory-native from birth**: a subagent run syncs to armory-todo, its context auto-hydrates from armory-memory, it handles images capability-aware via vision, and it drives its editor via cursor — all by default, from line 1 of the codebase.

This is the spine of the product. No external package can replicate it — they don't own the armory suite. The package name *is* the strategy: `armory-fleet` makes the integration unmistakable.

## 3. "Beat them all" thesis

The pi-subagent landscape is crowded (11+ packages; full landscape research at `./research/LANDSCAPE.md`). The incumbent `nicobailon/pi-subagents` (2688⭐, 91 npm versions) has a massive head start; a pure feature-parity catch-up race is unwinnable.

**Win by owning three dimensions competitors structurally cannot**, then reach parity on the rest:

| Owned dimension | Why competitors can't match | Contender that attempts it |
|---|---|---|
| **armory-native integration** | They don't own the armory suite | none |
| **CC + Pi as peer subagent backends** | Most are Pi-only; the one attempt (kky42/pi-flow, 66⭐) is early/foreground-only/no quality gates | kky42/pi-flow (weak) |
| **superpowers lifecycle as default execution model** | Only one attempt (teelicht/pi-superagents, 54⭐), synchronous-only, forked from nicobailon | teelicht/pi-superagents (weak) |

**Table-stakes parity** (not differentiators — must match by v1.0): fleet TUI, scheduling, git-worktree isolation, real cost accounting, quality patterns, workflows-as-code, event-bus/RPC composability. These are owned by nicobailon, tintinweb (702⭐), and QuintinShaw (287⭐) respectively.

## 4. Engine strategy — hybrid

A clean **greenfield orchestration core** (the `subagent` tool, armory-native agent registry, event/RPC surface, cross-harness + superpowers lifecycle, the `/fleet` panel) + **vendored MIT commodity plumbing** (worktree lifecycle, graceful turn limits, scheduling, concurrency queue) copied from mature packages *with attribution*, as isolated, swappable units.

- We **own the core** — the surface where the moat must feel native. This is what makes the "beat them all" claim credible (it's our core, not a 91-version fork).
- We **don't reinvent commodity plumbing** — worktree/scheduling/graceful-turns code is identical in every package; vendoring frozen, audited, attributed MIT modules leapfrogs the catch-up without inheriting a fork's architecture or upstream-drift.
- Vendored code lives in `src/vendor/<source>/` with a `NOTICE.md` per module crediting the origin + license; treated as frozen (no upstream rebase), audited to getpipher production standards, and isolated behind clean interfaces so each is replaceable.

## 5. Cross-cutting design principle — interactive-first `/fleet` panel

Per the getpipher UX mental model (`~/local-dev/getpipher/AGENTS.md`): *every capability lands as a panel tab/view + action-submenu entry FIRST, then the model-callable tool action — never the reverse.* Humans open `/fleet`; the model uses the `fleet` tool.

**`/fleet` (no-arg) opens the panel.** Tabs/views (each matures as its SPEC lands):

| View | Contents | Matures in |
|---|---|---|
| Fleet | live running + recent subagents (status · model · tokens · cost · duration · context%) | SPEC-1 (basic) → SPEC-5b (full + steering) |
| Agents | the registry: builtin + custom + armory-native agents, each showing model/tools/skills/armory-hooks | SPEC-1 → SPEC-2 |
| Runs | completed runs with results, replay/resume/fork | SPEC-5b |
| Scheduled | cron/interval/one-shot scheduled subagents, PID-locked | SPEC-5a |
| Backends | cross-harness backend config (Pi + CC), per-profile model/thinking/tools | SPEC-3 |
| Lifecycle | superpowers pipeline phase of active runs, toggles | SPEC-4 |
| Tiers | model-tier routing, cost caps, concurrency limits, worktree policy | SPEC-6 |

**Action submenu:** Run · Steer (mid-run message) · Stop · Pause/Resume · Save-as-workflow · View conversation · Fork · Resume · Set model · Schedule · Disable agent
**Inline `Input`:** single-line entry for prompts, model IDs, cron expressions, session_keys. (pi-tui cannot nest `ctx.ui.editor()` inside `ctx.ui.custom()` — single-line Input only; see the EditorTheme gotcha in `~/local-dev/getpipher/AGENTS.md`.)

## 6. Scope

**In scope (v1.0):** subagent delegation · armory-native custom-agent registry (todo-sync / memory-hydrate / vision / cursor hooks) · CC + Pi peer backends · superpowers lifecycle (brainstorm→plan→implement→review→finish) · async/background/scheduling · git-worktree isolation · `/fleet` panel (FleetView + live widget + conversation viewer + mid-run steering) · cost-aware model tiers (Ollama-Cloud / OpenRouter / frontier) · quality gates (verify / judgePanel / loopUntilDry + verification-before-completion + challenge-step lifecycle hooks) · workflows-as-code (JS orchestration + journaled resume) · event-bus + cross-extension RPC.

**Non-goals (v1 — deferred):**
- **Codex backend** — RECTOR's primary dual-arsenal is CC + Pi; Codex is a post-v1 SPEC.
- **Per-agent standalone persistent memory** — armory-memory *is* the memory; no parallel system.
- **Web / desktop / mobile UI** — TUI only, like all armory tools.
- **Security sandbox** — trusted-dev-environment, same posture as every peer (no sandbox boundary; the VM in workflows-as-code is for *determinism*, not security — per QuintinShaw's model).
- **Reimplementation of pi core** — we build on the SDK (`createAgentSession`), not fork pi.

**Success bar:** by v1.0, parity-or-better than nicobailon + tintinweb + QuintinShaw on all table-stakes, **plus** three dimensions they can't match — credibly "beat them all."

## 7. Architecture foundation

- **Engine primitive:** `createAgentSession()` from `@earendil-works/pi-coding-agent` SDK — spawns child Pi sessions (in-memory or file-backed `SessionManager`), configurable model/tools/resourceLoader. Every subagent package uses this; we do too.
- **Extension surface:** `pi.registerTool`, `pi.registerCommand`, `pi.events` (event bus), `pi.exec`, custom UI (`ctx.ui.custom`, widgets/footer/dialogs/overlay/custom-editor/autocomplete), message/entry renderers, shortcuts, flags, providers.
- **Child sessions** run via the SDK with a `ResourceLoader` that loads armory-native extensions (vision/cursor) + skills + agent frontmatter — so children are armory-aware by construction.
- **getpipher conventions:** raw `.ts` via tsx at runtime (no build step); `pnpm typecheck` + `pnpm test:run` (node:test via tsx) before release; publish via CI on `v*` tag using getpipher `NPM_TOKEN` org secret; release.yml mirrors armory-todo (idempotent npm publish + GitHub Release step).
- **EditorTheme gotcha awareness:** `ctx.ui.custom((tui, theme, kb, done) => …)` receives the full `Theme`; `ctx.ui.setEditorComponent((tui, theme, kb) => …)` receives `EditorTheme` (only `{borderColor, selectList}`). For real theme colors in custom editors, thread `() => ctx.ui.theme` (live getter), never the factory `theme` arg. The v0.2.1 cursor crash is the cautionary tale.

## 8. SPEC-N roadmap (7 specs)

**Sequencing principle:** moat-first. Each SPEC is independently shippable + competitively meaningful. SPEC-1+2 make the spine real; 3-4 expand the moat into broadly-competitive territory; 5a/5b close the operational + UI parity gap; 6 reaches the power-user tier + composability for v1.0.

### SPEC-1 — Core engine + armory-todo sync
Greenfield orchestration core: `subagent` tool (foreground, single synchronous delegate), child-session spawn via `createAgentSession`, custom-agent registry + frontmatter (`.pi/agents/` + global `~/.pi/agent/agents/`), **subagent runs are tracked in armory-todo** (the headline moat). Tracking policy — link to an existing open TODO when one matches the run's intent, otherwise create a `fleet` project task — is finalized in the SPEC-1 design; the invariant is *every active run is reflected in armory-todo*, never orphaned. Minimal `/fleet` panel: Fleet view (running + recent) + Agents view (registry), with Run action.
- **Vendored plumbing:** graceful turn limits, concurrency queue.
- **Done (v0.1):** delegate a task to a named armory-native agent in the foreground; it appears + updates in armory-todo; the `/fleet` panel lists runs + agents.
- **Competitive dimension:** Moat part 1 — nobody else has TODO-synced subagents.

### SPEC-2 — Deep armory integration
armory-memory context auto-hydrates child sessions (scoped per project/local/user), vision capability-aware image handling in children (delegate-to-vision only when primary is text-only; pass-through for multimodal), cursor editor in child sessions. Agents-view matures to show armory-hooks per agent.
- **Done (v0.2):** every agent is memory-hydrated, vision-capable, cursor-equipped by default — the full moat.
- **Competitive dimension:** Moat complete — uncopyable.

### SPEC-3 — Cross-harness peers (CC + Pi)
Claude Code as a peer subagent backend (`claude -p` child process), profile-based backend routing (`.pi/subagents/<name>.md` with `backend: pi | claude` field), `session_key` resume across backends. New `/fleet` Backends view.
- **Done (v0.3):** one task fans out across Pi + CC backends with per-profile model/thinking/tools; results synthesized in Pi.
- **Competitive dimension:** Dual-arsenal — only kky42 attempts, weakly.

### SPEC-4 — Superpowers-native lifecycle
brainstorm→plan→implement→review→finish as the default execution model, role-per-phase agents (scout/planner/worker/reviewer/oracle mapped to the superpowers skill set), lifecycle-skill injection (verification-before-completion, requesting/receiving-code-review, finishing-a-development-branch), subagent-driven-development + executing-plans wired natively. New `/fleet` Lifecycle view.
- **Done (v0.4):** `/fleet-implement <task>` runs the full superpowers pipeline via subagents with inline phase tracking.
- **Competitive dimension:** Superpowers-native — only teelicht, weakly.

### SPEC-5a — Operational runtime
Async/background runs + status + auto-delivery, scheduling (cron/interval/one-shot, session-scoped, PID-locked), git-worktree isolation for parallel edits (auto-commit to branch on completion). New `/fleet` Scheduled view.
- **Vendored plumbing:** scheduling, worktree lifecycle.
- **Done (v0.5a):** background parallel agents on isolated worktrees; schedule recurring subagents.
- **Competitive dimension:** Parity with nicobailon/tintinweb operational layer.

### SPEC-5b — Fleet TUI
FleetView (navigable agent list below editor), live widget (above-editor, animated spinners, token counts, context%), conversation viewer (live-scrolling overlay), mid-run steering (inline composer). New `/fleet` Runs view with replay/resume/fork.
- **Done (v0.5b):** full navigable fleet + live widget + steer any running agent mid-run.
- **Competitive dimension:** Parity+ with tintinweb's UI; strictly beats FleetView alone via the tabbed panel + action submenu.

### SPEC-6 — Power-user tier → v1.0
Cost-aware model tiers (Ollama-Cloud primary / OpenRouter fallback / frontier-for-audited-work routing, per-agent + per-phase), real cost accounting (tokens + cost per agent/phase/run, budgets), quality patterns (verify / judgePanel / loopUntilDry / completenessCheck / gate / checkpoint), verification-before-completion + challenge-step lifecycle hooks baked in, workflows-as-code (JS orchestration with `agent`/`parallel`/`pipeline`/`phase` + journaled resume / edit-and-resume), event-bus + cross-extension RPC (other extensions spawn/steer/observe subagents). New `/fleet` Tiers view.
- **Done (v0.6 / v1.0):** full power-user framework + composability surface; no table-stakes gap remains.
- **Competitive dimension:** Parity+ with QuintinShaw; the moat extends to composability (other extensions build on armory-fleet).

## 9. Dependencies & risks

- **pi SDK surface stability:** we target `^0.81.1`. Risk: pi extension API churn under 1.0. Mitigation: pin compat range, watch pi releases, surface breakage in CI.
- **CC backend coupling:** `claude -p` child-process interface is Anthropic-controlled. Risk: CLI flag changes. Mitigation: isolate the CC backend behind an adapter; version-detect.
- **Vendored-plumbing drift:** frozen modules may lag upstream bug fixes. Mitigation: NOTICE.md records origin + version + date; periodic audit; replace with greenfield if a module proves troublesome.
- **EditorTheme gotcha class:** the v0.2.1 cursor crash. Mitigation: type all `theme` params correctly (`EditorTheme` vs `Theme`); thread `() => ctx.ui.theme` for real colors; add an integration smoke inside real pi before each release (per AGENTS.md gotcha guidance).
- **Scope creep:** "beat them all" invites gold-plating. Mitigation: the 7-SPEC roadmap is the contract; each SPEC has an explicit "done"; YAGNI ruthlessly inside each.

## 10. Glossary

- **armory suite** — RECTOR's getpipher pi-extension family: armory-todo (cross-session TODO), armory-memory (cross-session memory), vision (capability-aware images), cursor (custom editor), and now armory-fleet (subagents).
- **agent** — a child Pi session with a focused task, defined by frontmatter (model/tools/skills/armory-hooks).
- **fleet** — the set of running + recent agents.
- **profile** — a cross-harness agent definition: backend + model + thinking + tools + role prompt (SPEC-3).
- **worktree isolation** — running an agent in a throwaway git worktree so parallel edits don't conflict.
- **superpowers lifecycle** — the brainstorm→plan→implement→review→finish pipeline (from the Superpowers skill set RECTOR uses).
- **journaled resume** — replay completed agent calls from cache on re-run; edit-and-resume reuses the unchanged prefix and re-runs only edited/new calls (QuintinShaw's model).

## 11. References

- Landscape research: `./research/LANDSCAPE.md` + contender READMEs in `./research/` (copied from the session's `/tmp/pi-subagents-research/`)
- pi extension API: `…/pi-coding-agent/docs/extensions.md` (Custom Tools, Events, Custom UI, ExtensionAPI Methods)
- pi SDK: `…/pi-coding-agent/docs/sdk.md` (`createAgentSession`, `SessionManager`, `ResourceLoader`)
- getpipher conventions: `~/local-dev/getpipher/AGENTS.md`
- armory UX mental model: `~/local-dev/getpipher/AGENTS.md` (interactive-first section)
- EditorTheme gotcha: `~/local-dev/getpipher/AGENTS.md` + `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-cursor/pi-extension-editor-theme-gotcha.md`
- Superpowers skills: `~/.pi/agent/skills/` (brainstorming, writing-plans, executing-plans, subagent-driven-development, systematic-debugging, test-driven-development, verification-before-completion, requesting/receiving-code-review, finishing-a-development-branch)