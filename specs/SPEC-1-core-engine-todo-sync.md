# SPEC-1 — Core Engine + armory-todo sync

> **Status:** DRAFT (brainstorming output, pre-plan) · **Owner:** RECTOR · **Created:** 2026-07-23
> **Package:** `@getpipher/armory-fleet` · **npm org:** getpipher (account `rz1989`) · **Repo:** `getpipher/armory-fleet`
> **Compatibility:** pi `^0.81.1`
> **Pipeline position:** PRD (done) → **SPEC-1 (this)** → spec → plan → implementation → SPEC-2 …
> **Anchors:** Master PRD [`../PRD.md`](../PRD.md) · Landscape research [`../research/`](../research/)

---

## 1. Overview & goals

SPEC-1 builds the greenfield orchestration core of `@getpipher/armory-fleet` and lands the **headline moat**: every active subagent run is reflected in armory-todo, never orphaned.

**In scope (v0.1):**
- A `spawnSubagent(opts)` engine — the single source of truth.
- A model-callable `subagent` tool (foreground, single synchronous delegate).
- Child-session spawn via `createAgentSession` from the pi SDK (in-memory, ephemeral).
- A custom-agent registry + frontmatter (`.pi/agents/` + global `~/.pi/agent/agents/`).
- armory-todo sync via a ports-and-adapters boundary (link-if-explicit-else-create; tracked-by-default with opt-out).
- A minimal `/fleet` panel: Fleet view (running + recent) + Agents view (registry) + Run action.
- Guards: `todo`-exclusion from child tools, concurrency=1 lock, inline `maxTurns=20` budget, Esc→child abort.

**Done bar (v0.1):** Delegate a task to a named agent (builtin or user-defined) in the foreground → it appears and updates live in armory-todo and the `/fleet` panel; the result returns to the parent; failures are actionable; no orphaned runs. The moat part 1 is real — nobody else has TODO-synced subagents.

---

## 2. Architecture

### 2.1 One engine, two surfaces

A single `spawnSubagent(opts)` core is the only thing that spawns a subagent. Two surfaces call it:

- The model-callable `subagent` tool (`src/tools/subagent.ts`) — `execute()` calls the engine.
- The human-driven `/fleet` panel Run action (`src/panel/fleet-panel.ts`) — calls the engine directly, never via an injected user message.

Both produce identical run-registry entries, identical armory-todo reflection, and identical Fleet-view rows. This is the getpipher interactive-first principle made literal: panel-first, tool-second, **one engine** beneath both.

### 2.2 Ports-and-adapters for the moat

Fleet core depends on a fleet-owned `TodoSyncPort` interface, not on armory-todo. `ArmoryTodoAdapter` is the **only** file that imports `@getpipher/armory-todo`. The defenses against armory-todo evolution:

- **Port insulation** — an armory-todo breaking change can only touch the adapter; fleet core never imports armory-todo types.
- **Version pin** — fleet declares `"@getpipher/armory-todo": "^0.5.x"`; npm semver `^0.x` does not auto-bump on minor, so a breaking `0.6.0` does not install until deliberately adopted.
- **CI typecheck alarm** — both packages ship raw `.ts`, so fleet's `pnpm typecheck` typechecks against armory-todo's real types; a breaking dep bump fails fleet CI before merge.
- **Single-author co-evolution** — both packages are RECTOR's in getpipher; a breaking change is a coordinated two-PR non-event (bump armory-todo → bump fleet range + adapter).

**Companion PR to armory-todo (part of SPEC-1 implementation):** add an `exports` map + thin `index.ts` re-exporting the stable public subset (`addTodo`, `listTodos`, `updateTodo`, `getTodo`, `completeTodo`, `parkTodo`, and the `Todo`/`AddInput`/`UpdateInput`/`ListFilter` types). Additive, no behavior change. A one-line note in armory-todo's README/AGENTS marks the `exports` surface as stable and `src/*` as internal.

### 2.3 Hybrid engine strategy (inherited from PRD §4)

Greenfield orchestration core (owned). Vendored MIT commodity plumbing is **deferred to SPEC-5a** (YAGNI for v0.1's concurrency=1 — a queue for one slot is buying a tractor to move a houseplant). SPEC-1 ships an inline `maxTurns=20` turn budget and a single-slot concurrency lock instead. The `src/vendor/<source>/NOTICE.md` convention is introduced at SPEC-5a on its first genuinely-shared non-trivial module.

---

## 3. Components (file layout)

```
src/
  engine/
    spawnSubagent.ts        # the one engine (tool + panel both call it)
    run-registry.ts         # in-memory run store (the Fleet/recent list)
    turn-budget.ts          # inline maxTurns=20 guard
    concurrency-lock.ts     # single-slot lock (concurrency=1)
  todo-sync/
    port.ts                 # TodoSyncPort interface (fleet-owned)
    adapter.ts              # ArmoryTodoAdapter — only file importing @getpipher/armory-todo
  registry/
    discovery.ts            # scan .pi/agents + ~/.pi/agent/agents, precedence, collision
    frontmatter.ts          # parse + v0.1 schema
  panel/
    fleet-panel.ts          # ctx.ui.custom component (Fleet + Agents views)
    rows.ts                 # row-shape functions (unit-testable)
  tools/
    subagent.ts             # the model-callable tool (thin wrapper over engine)
  index.ts                  # extension entry (registerTool + registerCommand + panel)
agents/
  general-purpose.md        # the builtin agent
```

---

## 4. The `subagent` tool contract

### 4.1 Parameters (v0.1)

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `agent` | string | ✅ | — | agent name from the registry |
| `task` | string | ✅ | — | the prompt handed to the child |
| `todoId` | string | — | — | explicit link (Q3a); validated to exist + be `open`/`in_progress` |
| `track` | boolean | — | `true` | opt-out for throwaways (Q3b) |
| `model` | string | — | agent frontmatter `model` or parent `ctx.model` | per-run model override |

**Deferred tool params** (recorded — distinct from frontmatter fields): `thinkingLevel` (SPEC-3; the *agent frontmatter* sets the child's thinking level in v0.1 — §7.2 — the tool caller just doesn't override it per-call yet), `cwd` (SPEC-5a — deferred deliberately: exposing cwd before worktree isolation invites the model to spawn agents in random dirs with no isolation).

### 4.2 Return shape

```
content: [{ type: "text", text: <child's final assistant text> }]
details: {
  runId: string,
  todoId: string | null,          // null when track:false
  agent: string,
  model: string,
  status: "running" | "completed" | "failed" | "aborted",
  durationMs: number,
  tokenTotal: number,
  track: boolean,
}
isError?: true                    // only on failed/aborted, with an actionable message
```

The text is the child's final assistant message — what the parent model reasons over. `details` carries run metadata for the Fleet panel and future Runs view; not shown to the model (pi convention: text + details split, like `bash`).

### 4.3 Run status set

`running | completed | failed | aborted` — four values.

- Turn-budget exhaustion (hit `maxTurns=20`) → `failed` with a specific message (`"hit turn budget (20) mid-task; partial result: …"`). Not a fifth status; the message disambiguates.
- User Esc → `aborted`.
- Model/provider error → `failed` + actionable message.
- Clean finish → `completed`.

### 4.4 What the parent sees while the child runs (UX)

Live status widget + Fleet-panel row. `ctx.ui.setWidget("fleet", ["▶ scout · 1420 tok · 18s · 32% ctx"])` updates from child `subscribe()` events on a throttled interval; the `/fleet` Fleet view shows the row live. Child tokens are **not** streamed into the parent conversation (that is a SPEC-5b "conversation viewer" feature). Esc on the parent wires to `child.abort()` (run status → `aborted`, todo restored).

---

## 5. The spawn lifecycle (data flow)

1. **Invoke** — model calls `subagent({agent, task, todoId?, track?, model?})`, or human presses Run on the Agents view (→ `task>` input → optional `link to todo? (id or blank)` input).
2. **Engine** — `spawnSubagent` acquires the concurrency lock (else reject immediately with an actionable message — §9.1). Resolves the agent from the registry (else actionable error listing available agents). Resolves model = `agent.model ?? parent ctx.model`. Computes child tools = `(agent.tools ?? piDefault) − ["todo"]` (§9.1 guard).
3. **Todo-sync (before run)** — via the adapter:
   - `track:false` → no todo touched.
   - `todoId` passed → validate it exists + is `open`/`in_progress` (else actionable error: `"linked todo td-xxx is <status>; cannot start run against a closed todo"`). Save its prior status. Set `in_progress`. Tag `source:"armory-fleet"`. Add note line `fleet-run:<runId>`.
   - no `todoId` + `track:true` → create a `fleet`-project task (`source:"armory-fleet"`, priority `med`), set `in_progress`, note `fleet-run:<runId>`.
4. **Child session** —
   ```ts
   createAgentSession({
     cwd: parentCtx.cwd,
     model, thinkingLevel: agent.thinkingLevel ?? model default,
     tools: childTools,
     resourceLoader: new DefaultResourceLoader({
       systemPromptOverride: () => agent.rolePrompt,
       skillsOverride: (cur) => ({ skills: [...cur.skills, ...agent.skills], diagnostics: cur.diagnostics }),
     }),
     sessionManager: SessionManager.inMemory(),
   });
   ```
   Subscribe to child events → update run-registry + live Fleet row + widget. Wire parent `ctx.signal` → `child.abort()`.
5. **Run** — `await child.prompt(task)`. Turn-budget counter aborts at 20 → `failed`. Esc → `aborted`.
6. **Todo-sync (after run)** — the hybrid restore-prior policy:
   - `track:false` → nothing.
   - **`completed`:** fleet-created → `done`. linked → restore prior status + result note.
   - **`failed`/`aborted`:** fleet-created → `open` + failure note (retryable). linked → restore prior status + failure note.
7. **Return** (tool path) — text + details per §4.2; `isError:true` + actionable message on `failed`/`aborted`.
8. **Dispose** — `child.dispose()`. Ephemeral transcript is gone; the only persistent trace is the armory-todo entry (the moat's point: work reflected in the board, not in a pile of session files).

### 5.1 The run↔todo link record

Fleet keeps its own **run registry** (in-memory map for SPEC-1; persisted to `~/.pi/agent/fleet/runs.json` in SPEC-5b). Each entry:
```
{ runId, todoId, agent, model, status, startedAt, endedAt, resultSummary, track }
```
The `todoId` on the run record is the authoritative link. The todo side carries `source:"armory-fleet"` + tag `fleet-run` + note `fleet-run:<runId>`, so the link is discoverable from armory-todo's side too (the armory-todo panel can show "linked to fleet run X"). `runId` format: `fl-<base36>-<6 random>`.

**`runId` is a lightweight handle, not the result.** This is the architectural commitment that scales to async: at SPEC-1 the tool returns the inline result because it waited; at SPEC-5a the same tool can return just the handle (result deferred) without breaking v0.1 callers — they already get `runId` in `details`.

---

## 6. Todo-sync port + adapter

### 6.1 The port (fleet-owned)

```ts
// src/todo-sync/port.ts
export interface TodoSyncPort {
  // returns the todoId linked/created, or null when track:false
  linkOrCreateRunTodo(run: RunMeta): Promise<{ todoId: string | null; priorStatus?: Status }>;
  markRunTodoDone(todoId: string | null, priorStatus: Status | undefined, result: string): Promise<void>;
  markRunTodoReverted(todoId: string | null, priorStatus: Status | undefined, reason: string): Promise<void>;
}
```

Fleet core (engine, panel, tool) depends only on `TodoSyncPort`. armory-todo types appear nowhere in core.

### 6.2 The adapter (only armory-todo importer)

```ts
// src/todo-sync/adapter.ts
import { addTodo, listTodos, updateTodo, getTodo } from "@getpipher/armory-todo";
export class ArmoryTodoAdapter implements TodoSyncPort { /* … */ }
```

Implements link-or-create, prior-status save/restore, status flips, note/tag writes, against armory-todo's public store API.

### 6.3 The "reflected" invariant (concrete definition)

*"Every active run is reflected in armory-todo, never orphaned"* means concretely: **while a run is active, its linked/created todo is `in_progress`** (armory-todo auto-injects active-box todos into every prompt, so an `in_progress` todo is live context for the parent — that's the reflection). On completion fleet gets out of the user's way (hybrid restore-prior).

**Why hybrid restore-prior (not mirror, not append-only):** fleet fully owns what it creates, and respects what it doesn't. A `fleet`-project todo is fleet's to close; a user's todo is the user's to close. `in_progress` is semantically honest (a subagent working on it *is* work in progress), and restore-prior returns the user's board to exactly its prior state — no surprise side-effects.

---

## 7. Agent registry + frontmatter

### 7.1 Discovery + precedence

Locations (mirroring pi's resource discovery): `.pi/agents/*.md` (project) + `~/.pi/agent/agents/*.md` (global), scanned at `session_start` + `/reload` (`resources_discover`).

- **Precedence on name collision:** project overrides global (matches pi's project-over-global settings convention; a project can pin a specific `reviewer` without touching the global one).
- **Collision within same scope:** load error (fail loud, never silently pick one) — surfaced via `ctx.ui.notify` + a diagnostic; the duplicate is ignored.
- **Invalid frontmatter:** skip + warn (one malformed agent file doesn't kill the registry).
- **Refresh:** re-scan on `session_start` (reason new/resume/fork) + `/reload`.

The builtin `general-purpose` is shipped from the package's own `agents/` dir and is overridable by a user's same-named file via the precedence rule.

### 7.2 Frontmatter schema (v0.1)

pi has no native "custom agent" frontmatter concept; fleet defines its own (as all contender packages do). Markdown file + YAML frontmatter + body = role prompt.

| Field | v0.1 | Deferred to | Notes |
|---|---|---|---|
| `name` | ✅ | | unique id; default = filename if omitted |
| `description` | ✅ | | "when to use this agent" — surfaced to the parent model in the `subagent` tool description + Agents view |
| `model` | ✅ | | `"anthropic/claude-sonnet-4"` style; omit = parent's default |
| `thinkingLevel` | ✅ | | `off\|minimal\|low\|medium\|high\|xhigh\|max`; omit = model default |
| `tools` | ✅ | | array; omit = pi default (`read`/`bash`/`edit`/`write`) |
| `skills` | ✅ | | array of skill names to preload into the child |
| body (role prompt) | ✅ | | the agent's system-prompt preamble |
| `todoSync` | ✅ (default true) | | the armory hook toggle; default-on is the moat |
| `memoryHydrate` | ❌ | SPEC-2 | armory-memory context hydration |
| `vision` | ❌ | SPEC-2 | capability-aware image handling |
| `cursor` | ❌ | SPEC-2 | custom editor in child |
| `maxTurns` | ❌ | SPEC-5a | graceful turn limit per agent |
| `backend` | ❌ | SPEC-3 | `pi\|claude` cross-harness routing |

Keeping `todoSync` as a *named frontmatter field with default true* (rather than implicit) is deliberate — it makes the moat a visible, toggleable contract, and it's the seam SPEC-2 fills with siblings (`memoryHydrate`/`vision`/`cursor`).

### 7.3 Design principle — no predetermined role taxonomy

The fleet agent registry is a **general-purpose mechanism**. Agents are user-defined, composable, and fit any conditions. The package ships **no predetermined role library** (no scout/researcher/planner/etc. canon). One `general-purpose` builtin is shipped for day-one runnability; the rest is user-authored.

**Flag for the SPEC-4 brainstorm (recorded, not resolved here):** PRD §8 SPEC-4 says "role-per-phase agents (scout/planner/worker/reviewer/oracle)." This principle suggests SPEC-4 should reconcile that — the superpowers lifecycle phases likely map to *behaviors / prompt templates / skills injected per phase* rather than a fixed named-agent library, and any role agents are user-authored. Resolved at SPEC-4 brainstorm.

### 7.4 The `general-purpose` builtin

```md
---
name: general-purpose
description: A focused general-purpose subagent delegate. Use for any task needing isolated work.
todoSync: true
---
You are a focused subagent delegate. Complete the assigned task thoroughly, work
autonomously to completion, and return a concise result summary. Do not call the
`todo` tool — the fleet engine manages todo tracking for you.
```

`model`, `thinkingLevel`, `tools`, `skills` omitted → sensible defaults. The explicit "don't call `todo`" line reinforces the §9.1 guard at the prompt layer (defense-in-depth).

---

## 8. The `/fleet` panel

`pi.registerCommand("fleet", …)` — **no-arg opens the panel.** No CLI-style `/fleet run <agent> <task>` shortcut in v0.1 (the panel's Run action covers it; per getpipher convention, slash subs are thin mirrors or omitted when the panel already handles it — omit here).

### 8.1 Structure

`/fleet` opens a full-screen `ctx.ui.custom()` component:

```
┌─ armory-fleet ─────────────────────────────────────┐
│ [Fleet]  Agents                                     │  ← tab bar (h/l or Tab)
├─────────────────────────────────────────────────────┤
│ ▶ fl-3kf9a2  general-purpose  running  18s  1420t   │  ← Fleet view rows (j/k)
│   32% ctx  td-mrubw7  "review auth module"          │
│ ✓ fl-8ka1bp  general-purpose  done   45s  3210t     │
│   td-mrvtp5k  "refactored X"                        │
│ ✗ fl-2kp9xa  reviewer        aborted 3s   120t      │
│   td-mrvtp5k  "user abort"                         │
├─────────────────────────────────────────────────────┤
│ r:Run  s:Stop  o:Open-todo  q:Quit                 │  ← action submenu
│ > _                                                 │  ← inline Input (on Run)
└─────────────────────────────────────────────────────┘
```

- **Tab bar:** `Fleet` (running + recent, in-memory) | `Agents` (registry). Switch with `Tab`/`h`/`l`.
- **List:** navigable `j`/`k`; the active row drives the action submenu.
- **Action submenu:** context-sensitive to the active view + row.
- **Inline `Input`:** single-line only (pi-tui cannot nest `ctx.ui.editor()` inside `ctx.ui.custom()` — the EditorTheme gotcha; see `~/local-dev/getpipher/AGENTS.md`).

### 8.2 Row shapes

- **Fleet view:** `▶/✓/✗ runId · agent · status · duration · tokens · ctx% · todoId · "result-summary"`
- **Agents view:** `name · [builtin|project|global] · model · tools · skills · todoSync:✓`

### 8.3 Action submenu (context-sensitive)

| View / row | Actions |
|---|---|
| Fleet (active run) | `r` Run-new · `s` Stop (Esc/abort) · `o` Open-todo (show the linked armory-todo entry) · `q` Quit |
| Fleet (done/aborted) | `o` Open-todo · `r` Run-new (re-run with same agent, pre-fills task) · `q` Quit |
| Agents | `r` Run (→ inline `task>` input → optional `link to todo?` input → spawn) · `e` Edit (open the agent `.md`) · `d` Reload registry · `q` Quit |

**"View conversation" is deliberately absent in v0.1** — child transcripts are ephemeral (disposed), so there is nothing to view after completion. The done-row shows only the `resultSummary` stored in the run-registry entry. The full conversation viewer is a SPEC-5b feature (when transcripts get persisted).

### 8.4 Run flow

1. Agents view → select agent → `r` → `task>` inline input.
2. Enter task → `link to todo? (id or blank): ` inline input (blank = create `fleet` task).
3. Enter/blank → `spawnSubagent({ agent, task, todoId?, track: true })` runs synchronously; the Fleet view appears with the new running row + live widget updates from child `subscribe()`; `Esc` aborts.
4. On completion, the row flips to `✓`/`✗` with the summary; control returns to the list.

**Panel Run exposes `todoId` linking (moat-integrity — a human spawning to advance an existing todo must be able to link instead of duplicating a `fleet` task). `track` toggle and `model` override are deferred to SPEC-5b** (convenience power-knobs; the agent frontmatter is where model defaults belong; per-run model override from the panel is a SPEC-5b fleet-TUI power-user concern).

---

## 9. Guards (non-negotiable)

### 9.1 `todo` excluded from child tools
Fleet is the single writer of armory-todo for a run; the child is a pure delegate. The child's effective tools = `(agent.tools ?? piDefault) − ["todo"]`, regardless of frontmatter or globally-loaded extensions. Global extensions may load (harmless context like the Open-TODOs block in the child's prompt is fine — context, not mutation), but the child cannot call the tool fleet owns. (Generalizes to SPEC-2: vision/cursor/memory hooks get *injected into the child deliberately by fleet's loader*, not inherited accidentally — same single-writer discipline.)

### 9.2 Concurrency=1
A single-slot lock in `spawnSubagent`. If the model issues two `subagent` calls in one turn (pi parallel-tool mode), the second is rejected immediately: `isError:true`, `"a subagent is already running (concurrency=1 in v0.1); wait for fl-xxx to finish or abort it first."` The real concurrency queue lands at SPEC-5a; v0.1 just enforces 1 cleanly.

### 9.3 Turn budget
Inline `maxTurns=20` counter; on exceed, `child.abort()` → run status `failed` + `"hit turn budget (20) mid-task; partial result: …"`. Per-agent `maxTurns` override deferred to SPEC-5a.

### 9.4 Esc-abort propagation
Parent `ctx.signal` → `child.abort()` → run status `aborted`, todo restored per §6.3 hybrid.

---

## 10. Error handling

Every failure is **actionable and specific** (never generic — per CIPHER constraints):

- Unknown agent → `"agent 'X' not in registry; available: general-purpose, <user agents>"`.
- Linked todo not found / not open/in_progress → `"linked todo td-xxx is <status>; cannot start run against a closed todo"`.
- Child provider error → surface the provider message.
- Turn-budget hit → `failed` + partial result.
- Concurrency-busy → name the running `runId`.

On any `failed`/`aborted`: the run-registry and armory-todo are always reconciled — no orphaned run, no orphaned `in_progress` todo left behind. `isError:true` on the tool result; the hybrid restore-prior policy runs in a `finally` so a crash mid-run still restores the todo.

---

## 11. Testing

`node:test` via tsx (getpipher convention). Target 80%+ on new code.

**Unit:**
- `engine/spawnSubagent` — mock child session; verify lock acquire/reject, model resolution, tool computation incl. `todo`-exclusion, lifecycle status transitions.
- `todo-sync/adapter` — link-or-create, prior-status save/restore, status flips, note/tag writes, against a temp store (use armory-todo's `TODO_DIR` env override or an in-memory store).
- `registry/*` — discovery, project-over-global precedence, same-scope collision (error), malformed frontmatter (skip+warn).
- `engine/turn-budget` — abort at 20, partial result.
- `engine/concurrency-lock` — second call rejected with the running `runId`.
- `tools/subagent` — thin wrapper: verify param validation + return shape.
- `panel/rows` — row-shape functions for Fleet + Agents views.

**Integration smoke (before release, per the EditorTheme-gotcha lesson):**
Spawn a real child session + render the `/fleet` panel inside real pi. Unit tests with hand-rolled fakes prove the *contract*, not the real TUI; the v0.2.1 cursor crash is the cautionary tale — always smoke inside real pi before shipping a getpipher extension.

---

## 12. Deferred (recorded, with landing SPEC)

| Deferral | Landing SPEC | Why deferred |
|---|---|---|
| `thinkingLevel` param | SPEC-3 | better as agent-frontmatter field |
| `cwd` param | SPEC-5a | no isolation pre-worktree is a footgun |
| `track` + `model` panel overrides | SPEC-5b | convenience power-knobs |
| `memoryHydrate` / `vision` / `cursor` frontmatter + fleet CustomResourceLoader | SPEC-2 | the rest of the armory moat |
| `maxTurns` per-agent + `src/vendor/` + concurrency queue | SPEC-5a | YAGNI at concurrency=1 |
| Run-registry persistence + FleetView + conversation viewer + mid-run steering | SPEC-5b | transcripts ephemeral in v0.1 |
| Cross-harness `backend` (`pi\|claude`) | SPEC-3 | dual-arsenal |
| `get_run_result` / async / background / scheduling | SPEC-5a | foreground synchronous in v0.1 |
| `label` param for runs | SPEC-5b | nothing to disambiguate at concurrency=1 |

Nothing is silently dropped; every deferral is recorded with its landing SPEC.

---

## 13. Done bar / success criteria (v0.1)

- ✅ Delegate a task to a named agent (builtin `general-purpose` or user-defined) in the foreground via the `subagent` tool **and** the `/fleet` panel — both over the same engine.
- ✅ The run appears and updates live in armory-todo (`in_progress` while active; restored/done on completion per hybrid) and the `/fleet` Fleet view + status widget.
- ✅ Linking to an existing open todo (explicit `todoId`) works on both surfaces; unlinked tracked runs create a `fleet`-project task; `track:false` opt-out works.
- ✅ The result returns to the parent model as text + `details`; failures are actionable + specific.
- ✅ Guards hold: `todo` never in child tools, concurrency=1 enforced, turn-budget aborts at 20, Esc aborts the child.
- ✅ No orphaned runs, no orphaned `in_progress` todos — including on failure/abort.
- ✅ `pnpm typecheck` + `pnpm test:run` green; integration smoke inside real pi passes; companion armory-todo `exports` PR merged.
- ✅ Published as `@getpipher/armory-fleet@0.1.0` via CI on `v0.1.0` tag.

**Competitive dimension (PRD §8 SPEC-1):** Moat part 1 — nobody else has TODO-synced subagents.

---

## 14. Decision log (brainstorm Q1–Q9)

| Q | Decision |
|---|---|
| Q1 | Public API on armory-todo (`exports` map + `index.ts` re-export) + adapter seam in fleet; ports-and-adapters. |
| Q1-follow-up | Versioning: port insulation + `^0.x` pin + CI typecheck alarm + single-author co-evolution. |
| Q2 | Run↔todo lifecycle = **C hybrid restore-prior**; in-memory run registry for SPEC-1; `source:"armory-fleet"` tag on the todo side. |
| Q3a | Link matching = **A explicit `todoId` only**; no fuzzy matching. |
| Q3b | Tracked by default + **`track:false` opt-out**; not always-tracked, not auto-prune. |
| Q4a | Params: `agent` + `task` + `todoId?` + `track?` + `model?`; defer `thinkingLevel`/`cwd`. |
| Q4b | Return: text + `details` (runId, todoId, agent, model, status, durationMs, tokenTotal, track); pi text/details convention. |
| Q4c | UX during run = **A live widget + Fleet row**; no token streaming into parent; Esc→child abort. |
| Q5a | Frontmatter v0.1 = name/description/model/thinkingLevel/tools/skills/body/todoSync; defer the 4 armory-hook siblings + maxTurns/backend. |
| Q5b | Discovery: project-over-global, fail-loud on same-scope collision, skip+warn on malformed. |
| Q5c | One `general-purpose` builtin; **no predetermined role taxonomy** — agents general + user-defined. |
| Q6 | Defer vendoring to SPEC-5a; inline `maxTurns=20` + single-slot lock for v0.1. |
| (interjection) | Each spawn gets a `runId` handle; child sessions ephemeral (`SessionManager.inMemory()`); inline result in v0.1; forward-compatible to async via runId-as-handle. |
| Q7a | One engine, two surfaces (tool + panel both call `spawnSubagent`). |
| Q7b | Panel structure + row shapes as specified. |
| Q7c | Action submenu as specified; no View-conversation in v0.1. |
| Q7d | Panel Run exposes `todoId` linking (moat-integrity, IN v0.1); `track`+`model` overrides deferred to SPEC-5b. |
| Q8 | Child uses `DefaultResourceLoader` (systemPromptOverride + skillsOverride); **`todo` excluded from child tools** (fleet is single writer). SPEC-2 promotes to a fleet CustomResourceLoader. |
| Q9a | Concurrency=1 enforcement via single-slot lock; 2nd call rejected with actionable message. |
| Q9b | Run status set = `running\|completed\|failed\|aborted`; turn-budget = `failed` + specific message. |
| Q9c | `/fleet` no-arg opens panel; no CLI spawn shortcut in v0.1. |
| Q9d | `general-purpose` builtin content as specified (minimal defaults + "don't call `todo`" line). |
| Q9e | Package layout + testing strategy as specified. |

---

## 15. References

- Master PRD: [`../PRD.md`](../PRD.md) (§4 engine strategy, §5 panel design, §7 architecture, §8 SPEC-1 scope)
- Landscape research: [`../research/`](../research/) — contender engine plumbing (nicobailon, tintinweb)
- pi SDK doc: `…/pi-coding-agent/docs/sdk.md` (`createAgentSession`, `SessionManager`, `DefaultResourceLoader`)
- pi extensions doc: `…/pi-coding-agent/docs/extensions.md` (`pi.registerTool`, `pi.registerCommand`, `ctx.ui.custom`, `ctx.ui.setWidget`)
- armory-todo source: `~/local-dev/getpipher/armory-todo/src/todo-store.ts` (the public store API to re-export)
- getpipher conventions + EditorTheme gotcha: `~/local-dev/getpipher/AGENTS.md`