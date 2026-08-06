<div align="center">

<img src="assets/armory-fleet-logo.png" alt="@getpipher/armory-fleet" width="220" height="220" />

# @getpipher/armory-fleet

**The armory suite's subagent orchestrator for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — a cross-harness, superpowers-native fleet where every agent is armory-native from birth.**

[![npm version](https://img.shields.io/npm/v/@getpipher/armory-fleet?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@getpipher/armory-fleet)
[![npm downloads](https://img.shields.io/npm/dm/@getpipher/armory-fleet?color=cb3837&logo=npm)](https://www.npmjs.com/package/@getpipher/armory-fleet)
[![pi compatibility](https://img.shields.io/badge/pi-%5E0.81.1-6f42c1?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHRleHQgeD0iNCIgeT0iMTgiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiNmZmYiPuKCrTwvdGV4dD48L3N2Zz4=)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/github/license/getpipher/armory-fleet?color=blue)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-593%20passing-21c463?logo=jest)](#testing)
[![release](https://img.shields.io/github/v/release/getpipher/armory-fleet?color=success&label=latest%20release)](https://github.com/getpipher/armory-fleet/releases)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL-lightgrey)](#compatibility)

[Why](#why) · [Features](#features-at-a-glance) · [Quick start](#quick-start) · [Architecture](#architecture) · [The fleet panel](#the-fleet-panel) · [Workflows-as-code](#workflows-as-code) · [Cost-aware tiers](#cost-aware-tiers) · [Roadmap](#roadmap) · [Ecosystem](#ecosystem)

</div>

---

## Why

The pi-subagent ecosystem is crowded — `nicobailon/pi-subagents` (2688⭐), `tintinweb/pi-subagents` (702⭐), `QuintinShaw/pi-dynamic-workflows` (287⭐), `kky42/pi-flow` (66⭐), `teelicht/pi-superagents` (54⭐). Three structural gaps remain open, and `armory-fleet` owns all three — then reaches parity on the rest to be the best pi-subagent package in the ecosystem.

| Gap | Status quo | armory-fleet |
|---|---|---|
| **Armory-native integration** | No external package can integrate with the armory suite; they don't own it. | Agents that sync to [armory-todo](https://github.com/getpipher/armory-todo), hydrate from [armory-memory](https://github.com/getpipher/armory-memory), see via [vision](https://github.com/getpipher/vision), and edit via [cursor](https://github.com/getpipher/cursor) **by default** — uncopyable. |
| **Cross-harness peers** | Only one early attempt runs Claude Code + Pi as peer backends, foreground-only. | First-class dual-arsenal topology — pi and Claude Code spawn as sibling backends from one fleet. |
| **Superpowers-native lifecycle** | Only one attempt wraps the superpowers skill pipeline, synchronous-only. | The full superpowers lifecycle (brainstorm → plan → implement → review → finish) with checkpoints, quality gates, and lifecycle hooks baked in. |

Beyond those: a fleet TUI, cron/interval scheduling, git worktree isolation, cost accounting, quality gates, workflows-as-code, and a journaled event-bus — all in one package.

> **Vision, spine, and the 7-SPEC roadmap** live in [`PRD.md`](./PRD.md). The landscape deep-read (11+ packages mapped, 5 contenders deep-read) is in [`research/`](./research).

---

## Features at a glance

| Capability | What you get |
|---|---|
| 🧬 **Armory-native agents** | Every child syncs to `armory-todo`, hydrates from `armory-memory`, sees via `vision`, edits via `cursor` — by default, from birth. No bolt-on. |
| 🏛️ **Cross-harness backends** | Spawn pi **and** Claude Code sessions as peer backends from one fleet. Auto-detect Claude; hook-parity keeps both on equal footing. |
| 🦸 **Superpowers lifecycle** | `brainstorm → plan → implement → review → finish`, checkpoint-driven, skill-loaded per phase. `/fleet-implement <task>` runs the whole pipeline. |
| 🎚️ **Cost-aware tiers** | `economy` / `standard` / `frontier` model tiers with cost caps + context floors. Route cheap work to cheap models, escalate when it matters. Live cost $ + context % per run. |
| 🚦 **Quality gates** | `verification-before-completion`, `completeness-check`, `gate`, `verify` — built-in. Register your own. Composite helpers: `judgePanel`, `loopUntilDry`, `retry`. |
| 🧩 **Workflows-as-code** | Author multi-phase workflows in a JS DSL with `agent()`, `pipeline()`, `phase()`, `checkpoint()`. 5 builtins ship: adversarial-review, code-review, codebase-audit, deep-research, multi-perspective. Journaled + resumable. |
| 🖥️ **Fleet TUI** | `/fleet` opens an interactive panel: Runs, Tiers, Lifecycle, Workflows, Conversation viewer. Live widget, mid-run Steer/Stop, edit-resume, save-as. |
| ⏱️ **Scheduling** | Cron expressions, intervals, one-shot ISO datetimes. PID-locked scheduler, session-scoped (no catch-up). Background runs on isolated git worktrees. |
| 🔒 **Worktree isolation** | Background runs get isolated git worktrees (in-place fallback for non-git cwds). Foreground runs share the session cwd. |
| 📒 **RunLog + journaling** | Every run is journaled; interrupted workflows recover on restart. A results inbox lets the model pull completed background runs. |
| 🔄 **Edit-and-resume** | Re-run a workflow by replaying the unchanged prefix and re-running only the edited suffix. |
| 📡 **Vision built-in** | `describe_image` tool is wired into child sessions — agents can see screenshots and diagrams without leaving the fleet. |

---

## Quick start

### Install

armory-fleet is a [pi extension](https://pi-coding-agent.dev/docs/extensions) — it loads inside pi, no build step.

```bash
# 1. Add to your pi packages (~/local-dev/arsenal or your package dir)
pnpm add @getpipher/armory-fleet

# 2. Register in ~/.pi/agent/settings.json
```

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "@getpipher/armory-fleet@0.12.0"
    // + its armory siblings: armory-todo, armory-memory, vision, cursor
  ]
}
```

```bash
# 3. Reload pi (/reload) and open the panel
pi
# inside pi → /fleet
```

### Your first subagent (model-callable tool)

The `subagent` tool is what the model calls to delegate a focused task. Every child is armory-native by default.

```ts
// the agent calls this — not you
subagent({
  agent: "general-purpose",
  task: "Audit src/auth/ for token-handling bugs; report findings.",
  // optional: model, lifecycle, todoId, background, isolation, schedule, maxTurns
});
```

| Param | Effect |
|---|---|
| `agent` | Agent definition to spawn (from `agents/` or discovered). |
| `task` | The prompt handed to the child. |
| `model` | Override the session model. **Tip:** omit to inherit the session model, or use `Ollama/...` when the session is on Ollama — don't cross providers. |
| `lifecycle` | Run the task through a superpowers lifecycle (e.g. `default`) instead of a single delegate. |
| `todoId` | Link the run to an existing armory-todo entry. |
| `track` | Default `true` (syncs to armory-todo). Pass `false` only for throwaway lookups. |
| `background` | Fire without awaiting — run goes to the async pool on an isolated git worktree. |
| `isolation` | `worktree` (default for bg in a git repo) · `none` (in-place) · `auto`. |
| `schedule` | Cron (`0 9 * * 1-5`), interval (`30m`), or one-shot ISO datetime. Session-scoped, no catch-up. |
| `maxTurns` | Per-run turn budget (default 20). Raise for complex multi-step tasks. |

### Your first workflow

Workflows are plain JS files evaluated in a sandboxed vm realm. The orchestration primitives — `agent`, `parallel`, `pipeline`, `phase`, `gate`, `judgePanel`, `loopUntilDry`, `retry`, `checkpoint`, `verify`, `workflow`, `log` — are **injected globals** (no imports). The only thing you `export` is `meta`.

```js
// ship-feature.js — drop into a workflows/ dir discovered by WorkflowRegistry
export const meta = {
  name: 'ship-feature',
  description: 'Plan → implement → 3 parallel review angles with a gate',
  phases: [{ title: 'Plan' }, { title: 'Implement' }, { title: 'Review' }],
}

phase('Plan')
const plan = await agent('Plan this feature: ' + args.task, { tier: 'low' })

phase('Implement')
const impl = await agent(`Implement the plan:\n${plan}`, { tier: 'medium' })

phase('Review')
const angles = ['security', 'performance', 'correctness']
const reviews = await parallel(
  angles.map((a) => () => agent(`Review the implementation for ${a} issues.`, { tier: 'low' })),
)

// gate: revise the synthesis until it passes a validator
const synthesis = await gate(
  async (_feedback, n) => n === 0
    ? agent(`Synthesize ${reviews.length} reviews.`, { tier: 'low' })
    : agent('Revise synthesis per feedback.', { tier: 'low' }),
  (v) => typeof v === 'string' && v.length > 200 ? { ok: true } : { ok: false, feedback: 'more detail' },
  { attempts: 3 },
)

return { plan, impl, reviews, synthesis }
```

Open `/fleet → Workflows`, pick `ship-feature`, run it. The panel shows live phase progress; mid-run you can Steer (inject a message) or Stop. The realm also exposes `args`, `cwd`, and a `budget` object (`{ total, spent(), remaining() }`) so workflows can self-limit.

### Your first lifecycle run

```text
/fleet-implement Refactor the auth module to use the new session API --auto
```

Runs `brainstorm → plan → implement → review → finish` autonomously. Drop `--auto` for checkpointed mode (pauses at each checkpoint; continue/revise/abort from `/fleet → Lifecycle`).

---

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │              pi host session                 │
                        │   (loads @getpipher/armory-fleet extension)  │
                        └───────────────────────┬─────────────────────┘
                                                │
        ┌───────────────────────────────────────┼───────────────────────────────────────┐
        ▼                                       ▼                                       ▼
  subagent tool                          fleet tool                           /fleet panel
  (model-callable)                  (workflow runner)                    (FleetView TUI)
        │                                       │                                       │
        ▼                                       ▼                                       ▼
  createAgentSession()                WorkflowController                  Runs · Tiers · Lifecycle
  (pi SDK child)                      + ConcurrencyPool                   Workflows · Conversation
        │                             + adapters                            + live widget
        ├─→ armory-todo sync          + journal/resume
        ├─→ armory-memory hydrate           │
        ├─→ vision (describe_image)         ▼
        ├─→ lifecycle + gates          backend registry
        └─→ tier routing               (pi | Claude Code)
```

### Core engine

- **Engine primitive:** `createAgentSession()` from the pi SDK — child Pi sessions, in-memory or file-backed `SessionManager`, `ResourceLoader`. Each child is wrapped to emit `session_init` on subscribe so the fleet can track it from the first event.
- **Child loader:** `buildChildLoader()` threads armory-todo, armory-memory, and vision into every child's resource + tool set — armory-native from birth, cwd-agnostic.
- **Concurrency:** a single-slot lock for foreground runs + a `ConcurrencyPool` for parallel workflow branches.
- **Turn budget:** `engine/turn-budget.ts` caps each child's run; the `subagent` tool surfaces exhaustion as a structured status (not a silent truncation).

### Armory integration (the uncopyable layer)

| Sibling | What the fleet wires in | Where |
|---|---|---|
| [armory-todo](https://github.com/getpipher/armory-todo) | Every run syncs to the cross-session TODO store. Pass `todoId` to link. | `src/todo-sync/` |
| [armory-memory](https://github.com/getpipher/armory-memory) | Children hydrate project memory on spawn. Shared port, cwd-agnostic. | `src/memory-hydrate/` |
| [vision](https://github.com/getpipher/vision) | `describe_image` tool is wired into child sessions. | `src/vision/` |
| [cursor](https://github.com/getpipher/cursor) | Children edit through the cursor extension when present. | (via child loader) |

### Cross-harness backends

`src/backend/` ships a backend registry with **pi** (default) and **Claude Code** as peer backends. `detectClaude()` auto-discovers Claude; `PI_HOOK_PARITY` / `CLAUDE_HOOK_PARITY` tables keep both backends on equal footing. `hook-parity.ts` normalizes lifecycle/event hooks across harnesses. A `ResumeStore` persists backend session IDs so cross-harness runs can resume.

### Superpowers lifecycle

The default lifecycle (`src/lifecycle/default.ts`) is the superpowers-native 5-phase pipeline:

| Phase | Skills loaded | Checkpoint? | Gates |
|---|---|---|---|
| `brainstorm` | `brainstorming` | ✅ | — |
| `plan` | `writing-plans` | ✅ | `completenessCheck` |
| `implement` | `executing-plans`, `test-driven-development`, `verification-before-completion` | ❌ | `verification-before-completion`, `completenessCheck`, `gate` |
| `review` | `requesting-code-review`, `receiving-code-review` | ✅ | — |
| `finish` | `finishing-a-development-branch` | — | — |

Custom lifecycles: drop a YAML file in your `lifecycles/` dir, register via `discoverLifecycles()`. Gates are registered on a `GateRegistry` (`fleet-register-gate` command for runtime extensibility).

### Quality gates

Built-in (`src/lifecycle/gates/`): `verification-before-completion`, `completeness-check`, `gate`, `verify`.

Composite helpers (`src/workflows/helpers/`) — usable from any workflow:

| Helper | What it does |
|---|---|
| `judgePanel` | Run N judge agents; majority/weighted verdict. |
| `loopUntilDry` | Re-run an agent until a dry-run gate passes. |
| `retry` | Retry an agent with backoff on failure. |
| `checkpoint` | Pause a workflow for human review. |
| `completeness-check` / `gate` / `verify` | Gate wrappers for workflow use. |

### Cost-aware tiers

`src/tiers/` ships three built-in tiers:

| Tier | Models | Cost cap | Context floor |
|---|---|---|---|
| `economy` | `Ollama/minimax-m3:cloud` | — | — |
| `standard` | `Ollama/glm-5.2:cloud`, `Ollama/minimax-m3:cloud` | — | — |
| `frontier` | `anthropic/claude-sonnet-4`, `Ollama/glm-5.2:cloud` | $5 | 200k ctx |

Live cost $ and context % are tracked per run and surfaced in the Tiers view. Override per-run with `model`, or let the tier registry route based on the task class.

### Operational runtime

`src/runtime/` — the async/scheduling spine:

- `async-runner.ts` — background dispatch (fire-and-forget).
- `run-journal.ts` + `run-log.ts` — durable run records; `reconcile.ts` reattaches orphaned runs on restart.
- `concurrency-pool.ts` — bounded parallel branches.
- `results-inbox.ts` — the model pulls completed background runs via the `fleet_results` tool.
- `resume.ts` — scan for resumable runs + workflows.

### Scheduling + worktree

`src/scheduling/` — cron expressions (`expressions.ts`), a `Scheduler` with PID-locking (`pid-lock.ts`), session-scoped (no catch-up). `src/worktree/` — `WorktreeService` for isolated bg-run worktrees + `DiffService` for reviewable diffs.

---

## The fleet panel

`/fleet` opens an interactive TUI panel (TUI-only; in non-interactive modes use the `subagent` tool).

| View | What it shows |
|---|---|
| **Runs** | Running + recent subagents; status, cost, context %, agent, model. Action submenu: Steer, Stop, View conversation. |
| **Tiers** | Per-tier model lists, cost caps, context floors. Configure routing. |
| **Lifecycle** | Active lifecycle runs; Continue/Revise/Abort at checkpoints. |
| **Workflows** | Registered workflows + live runs. Run, edit-resume, save-as, view result, checkpoint. |
| **Conversation** | The full message timeline for any selected run. |

A live `FleetWidget` can render in the pi footer/overlay for at-a-glance fleet status while you work.

### Slash commands

| Command | Purpose |
|---|---|
| `/fleet` | Open the interactive fleet panel (TUI). |
| `/fleet-implement <task> [--lifecycle <name>] [--auto]` | Run a task through the superpowers lifecycle. |
| `/fleet-register-gate` | Register a custom gate on the fleet gate registry (extensibility). |

### Model-callable tools

| Tool | Purpose |
|---|---|
| `subagent` | Delegate a focused task to a child agent (sync foreground or async background). |
| `fleet` | Run + control fleet workflows (JS orchestration: `agent`, `pipeline`, `phase`, checkpoints). |
| `fleet_results` | Pull completed background run results from the inbox. |

---

## Workflows-as-code

Workflows are authored in a JS DSL (`src/workflows/source.ts` parses; `vm-realm.ts` evaluates). 5 builtins ship in `src/workflows/builtin/`:

| Workflow | Description | Phases |
|---|---|---|
| `adversarial-review` | Red-team + blue-team review with judge panel | Attack → Defend → Judge |
| `code-review` | 7 parallel review angles plus verification | Review → Verify |
| `codebase-audit` | File-tree scan with completeness check | Scan → Audit |
| `deep-research` | 3-round discovery loop with de-duplication | Discover → Synthesize |
| `multi-perspective` | 4 personas review the same artifact | Review → Merge |

Every workflow run is **journaled** (`workflows/journal.ts`) and **resumable**. `edit-resume` replays the unchanged prefix from cache and re-runs only the edited suffix. `runtime/controller.ts` orchestrates; `runtime/pause-gate.ts` handles checkpoints; `runtime/adapters.ts` binds the controller to the fleet's spawn + accounting.

**Full JS DSL API reference:** [`docs/workflows.md`](./docs/workflows.md) — `export const meta`, `agent()`/`parallel()`/`pipeline()`/`phase()`, the 7 helpers, the script context, worked examples, and the error surface.

---

## Roadmap

armory-fleet follows a PRD → SPEC-N (brainstorm → spec → plan → implementation) pipeline. **16/16 phases done through v0.12.0.**

| SPEC | Headline | Status | Artifact |
|---|---|---|---|
| PRD | Master PRD | ✅ done | `PRD.md` |
| RESEARCH | Landscape research (11+ packages, 5 deep-reads) | ✅ done | `research/` |
| SPEC-1 | Core engine + armory-todo sync | ✅ done | PR #1 · `547319b` |
| SPEC-2 | Deep armory integration (memory/vision/cursor) | ✅ done · @0.2.0 | PR #2 · `c6e727c` |
| SPEC-3 | Cross-harness peers (pi + Claude Code) | ✅ done · @0.3.0 | PR #4 · `5bb75fb` |
| SPEC-4 | Superpowers-native lifecycle | ✅ done · @0.4.0 | PR #5 · `67ff9b4` |
| SPEC-5a | Operational runtime (async/scheduling/worktree) | ✅ done · @0.5.2 | PR #6 · `52e3477` |
| SPEC-5b-1 | RunLog seam + Runs view | ✅ done · @0.6.0 | PR #7 · `54b1b10` |
| SPEC-5b-2 | Live widget + FleetView + Q9 | ✅ done · @0.7.0 | PR #8 · `9266a7` |
| SPEC-5b-3 | Conversation viewer + timeline fix | ✅ done · @0.8.0 | PR #9 · `adc0034` |
| SPEC-5b-4 | Mid-run steering (Steer) + Stop | ✅ done · @0.9.1 | PR #10 + #11 + #12 |
| SPEC-6-1 | Cost-aware tiers + cost $ + context % + Tiers view | ✅ done · @0.10.x | PR #15/#16/#17 |
| SPEC-6-2 | Quality gates + lifecycle hooks | ✅ done · @0.11.0 | PR #18 · `cda5e2b` |
| v0.11.1 | bg dispatch isolation split (non-git cwd fix) | ✅ done · @0.11.1 | PR #19 · `51956e0` |
| **SPEC-6-3** | **Workflows-as-code (release-gate completion)** | ✅ done · @0.12.0 | PR #21 · `9986ad1` |
| SPEC-6-4 | Event-bus RPC + live conversation viewer → v1.0 | 🚧 next | — |

See the [full release history](https://github.com/getpipher/armory-fleet/releases) and the [PRD](./PRD.md) §8 for the roadmap rationale.

---

## Ecosystem

armory-fleet is the orchestrator in the [getpipher](https://github.com/getpipher) armory suite — the default substrate it runs agents on:

| Package | Role |
|---|---|
| [armory-todo](https://github.com/getpipher/armory-todo) | Global cross-session TODO store (the fleet syncs every run to it). |
| [armory-memory](https://github.com/getpipher/armory-memory) | Project memory hydration for child agents. |
| [vision](https://github.com/getpipher/vision) | The `describe_image` tool, wired into fleet children. |
| [cursor](https://github.com/getpipher/cursor) | Custom editor component for the pi TUI. |

---

## Conventions

- **No build step** — extensions ship raw `.ts` via tsx at pi runtime. `pnpm typecheck` + `pnpm test:run` before release.
- **Tests** — `node:test` via tsx in `test/*.test.mts`, importing from `../src/...`. 593 passing.
- **Publish** — CI on `v*` tags using the getpipher `NPM_TOKEN` org secret (`release.yml` mirrors armory-todo: idempotent npm publish + GitHub Release).
- **Interactive-first UX** — every capability lands as a `/fleet` panel tab/view + action submenu first, then the model-callable tool action.

<a id="testing"></a>
### Verify locally

```bash
pnpm install
pnpm typecheck
pnpm test:run --test-timeout=30000   # 593/593
```

### Release-gate smoke (mandatory before any release)

```bash
pi --no-extensions -e ./src/index.ts --no-session --approve
# inside: /fleet → Workflows → verify the 5 builtins render + a workflow runs end-to-end
```

---

## Compatibility

- pi `^0.81.1`
- Node `>=22` (tsx runtime)
- Platform: macOS, Linux, WSL

## License

MIT — see [LICENSE](./LICENSE). © RECTOR ([@rz1989s](https://github.com/rz1989s)).

<div align="center">

Built with Ihsan · Maintained by [RECTOR](https://github.com/rz1989s) · [getpipher](https://github.com/getpipher)

</div>