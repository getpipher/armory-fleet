# Pi-Subagents Landscape Research

**Date:** 2026-07-23
**Goal:** Map the existing pi-subagent package ecosystem to inform an in-house `@getpipher/*` package that beats the field.

## The field (npm + GitHub, ranked by stars)

| Package | ⭐ | Author | v / npm | Pitch |
|---|---|---|---|---|
| `pi-subagents` | 2688 | nicobailon | v0.35.1 (91 versions) | **Incumbent.** chains, parallel, async/bg, forked, watchdog, supervisor coord, 8 builtin agents, persistent memory, scheduling, extension-delegation API, permission-system integration |
| `@tintinweb/pi-subagents` | 702 | tintinweb | — | CC-native feel. Agent/get_subagent_result/steer_subagent, FleetView, live widget, conversation viewer, mid-run steering, resume, event bus + cross-ext RPC, scheduling, model-scope enforcement |
| `pi-interactive-subagents` | 595 | HazAT | — | cmux terminal session orchestration (spawn/orchestrate/manage) |
| `pi-dynamic-workflows` | 287 | QuintinShaw | 3.x | JS orchestration scripts (agent/parallel/pipeline/phase), VM-sandbox determinism, journaled resume (edit-and-resume), per-agent model routing (tiers), worktree isolation, real cost accounting, quality patterns (verify/judgePanel/loopUntilDry/completenessCheck/gate/checkpoint), built-in workflows, /ultracode |
| `edxeth/pi-subagents` | 89 | edxeth | — | Power-user framework: named agents, Herdr/cmux/tmux/zellij/WezTerm, bg workers, fork/resume, child→parent messaging, orchestrator mode |
| `mjakl/pi-subagent` | 72 | mjakl | — | Lightweight |
| `kky42/pi-flow` | 66 | kky42 | — | **Cross-harness: Pi + Codex CLI + Claude Code** as subagent backends. Agent + workflow, profile routing, session_key resume, headless API |
| `teelicht/pi-superagents` | 54 | teelicht | — | **Superpowers-native.** Role-specific agents per dev phase, model tiers, /sp-settings, Plannotator, worktree isolation, lifecycle-skill injection, synchronous-only |
| `pi-landstrip` | — | jarkkojs | v0.17.34 | Sandbox-aware + interactive command permissions |
| `@gotgenes/pi-subagents` | — | gotgenes | v18.1.1 | Friendly fork of tintinweb — "in-process sub-agent core" + typed API + lifecycle events (a base to build on, not an end-user tool) |
| Others | — | various | — | narumiruna/pi-extensions (bundle), AlexParamonov/pi-subagents-lite, minghinmatthewlam, NikiforovAll/pi-kanban, gutomec/pi-squad-loader |

## Feature matrix (the top 5 contenders)

| Dimension | nicobailon | tintinweb | QuintinShaw | kky42/pi-flow | teelicht |
|---|---|---|---|---|---|
| **Architecture** | child Pi sessions, sync+async | child Pi sessions, sync+async | JS orchestration in VM sandbox (deterministic), bg runs | child sessions, foreground-only | child Pi, synchronous/blocking only |
| **Tool surface** | `subagent` + chain/parallel + programmatic mgmt | `Agent`/`get_subagent_result`/`steer_subagent` | `agent`/`parallel`/`pipeline`/`phase`/`verify`/`judgePanel`/`loopUntilDry`/`gate`/`checkpoint` | `Agent` + `workflow` | `subagent` (single, sync) |
| **Cross-harness** | Pi-only | Pi-only | Pi-only | **Pi + Codex + Claude Code** | Pi-only |
| **Builtin agents** | 8 (scout, researcher, planner, worker, reviewer, context-builder, oracle, delegate) | 3 (general-purpose, Explore, Plan) + custom | none (workflows define roles) | 1 (general-purpose) + custom profiles | role-per-phase (superpowers lifecycle) |
| **Workflows as code** | chain files (YAML-ish) | — | **JS scripts, journaled resume, edit-and-resume** | JS workflows, saved/reusable, headless API | — |
| **Concurrency** | globalConcurrencyLimit, maxSubagentSpawnsPerSession, queueing | configurable limit (default 4), smart group-join | clamped to 16, up to 1000 total, queueing | one global limit, queueing | serial |
| **Background/async** | asyncByDefault, scheduledRuns, forked runs | run_in_background, scheduling (cron/interval/one-shot) | bg runs + live panel + auto-deliver | foreground-only (no hidden bg) | none |
| **Model routing** | per-agent, defaultModel, agentOverrides, fallbackModels, watchdog model, disableThinking | per-agent frontmatter, fuzzy model select, model-scope enforcement | tiers (small/medium/big), exact provider/model:thinking, per-phase | per-profile backend+model+thinking | tiers (cheap/balanced/max), per-tier thinking, /sp-settings picker |
| **Worktree isolation** | ✅ | ✅ (auto-commit to branch) | ✅ (`isolation: "worktree"`) | — | ✅ |
| **Mid-run steering** | ✅ (programmatic) | ✅ (steer_subagent + inline composer) | — (journaled resume instead) | — | — |
| **Session resume/fork** | ✅ forked runs, resume | ✅ resume, inherit_context | ✅ journaled replay | ✅ session_key continuation | — |
| **Persistent memory** | ✅ per-agent | ✅ 3 scopes (project/local/user) | — | — | — |
| **Skills integration** | ✅ bundled skill, skill preload | ✅ skill preloading | ✅ packaged workflow-authoring skill | — | ✅ lifecycle-skill injection (superpowers) |
| **TUI** | async widget, fleet view | live widget + FleetView + conversation viewer + scheduled-jobs UI | live panel + `/workflows` navigator + syntax-highlighted pager | live rows (tokens/cost/cache) | `/sp-settings`, `/subagents-status` |
| **Cross-ext RPC / event bus** | ✅ extension-delegation API + bg-work provider API | ✅ event bus (`subagents:*`) + RPC (spawn/stop/ping) | — | — | — |
| **Cost/usage** | token counts in widget | token counts + context-window % + compaction count | **real tokens + cost per agent/phase/run, budgets** | **duration, tokens, cache reads/writes, cache-hit rate, cost** | — |
| **Quality patterns** | review-loop builtin | — | verify/judgePanel/loopUntilDry/completenessCheck/gate | — | (superpowers lifecycle skills) |
| **Security** | pi-permission-system integration, tool/extension selection | model-scope enforcement, tool denylist | VM sandbox (determinism), project-trust | approval/sandbox bypass flags, "trusted env" | project-trust mirroring, extension allowlist |
| **Scheduling** | ✅ scheduledRuns | ✅ cron/interval/one-shot, session-scoped, PID-locked | — | — | — |
| **Maturity** | highest (91 versions, 2688⭐, active daily) | high (702⭐) | high (287⭐, 3.x milestone) | early (66⭐) | early (54⭐) |

## White space — where the field is weak

1. **Cross-harness (CC + Pi + Codex as peers)** — only `kky42/pi-flow` does this, and it's early (66⭐), foreground-only, no quality gates. Nobody owns it well.
2. **Superpowers-native orchestration** — only `teelicht/pi-superagents`, early (54⭐), synchronous-only, forked from nicobailon. Nobody bakes the full superpowers lifecycle (brainstorm → plan → implement → review → finish) in deeply.
3. **Ecosystem integration** — no package integrates with an armory-style cross-session TODO + memory + vision + cursor suite. That's a moat only a getpipher package can build.
4. **Cost-aware model strategy matching a stated philosophy** — QuintinShaw has tiers but no Ollama-Cloud-primary/OpenRouter-fallback/frontier-for-audited-work routing philosophy baked in.
5. **Baked-in quality gates** — QuintinShaw has patterns; nobody auto-runs verification-before-completion / challenge-step / receiving-code-review as native lifecycle hooks.
6. **Clean getpipher extension hygiene** — EditorTheme-vs-Theme awareness, raw-.ts-no-build, interactive-panel-first UX. External packages have crashed pi on the theme gotcha before.

## Initial "beat the field" thesis (to validate in brainstorming)

A cross-harness (**CC + Pi** peer backends) **superpowers-native** subagent orchestrator, tightly integrated with the **armory ecosystem** (todo/memory/vision/cursor), with **cost-aware model tiers** matching the Ollama-Cloud/OpenRouter/frontier strategy, and **baked-in quality gates** (auto-review, challenge step, verification evidence). That combination does not exist anywhere in the field.