# SPEC-4 — Superpowers-native lifecycle

**Status:** Approved design (brainstorm 2026-07-24, 7 Q&A). Pre-implementation.
**Compatibility:** pi `^0.81.1` (dev box 0.82.0). Builds on SPEC-1/2/3 (all merged + released through v0.3.0).
**Competitive dimension (PRD §8):** Superpowers-native — only teelicht, weakly.

## 1. Overview & goals

SPEC-4 makes the fleet **superpowers-native**: a *lifecycle* runs a task through the
superpowers pipeline (brainstorm→plan→implement→review→finish) by spawning one child
subagent per phase, threading each phase's file artifacts into the next, and pausing for
human review at each phase boundary (Continue/Revise) by default — with an `auto` escape
for fire-and-forget runs.

A lifecycle is **not** a new backend, a new agent type, or a fixed role library. It is a
**phase-injection config** layered *above* the SPEC-1/2/3 engine. The creation seam
(`ChildSessionFactory` / `ChildSession` / `BackendRegistry`) is untouched — every phase is
an ordinary `subagent` spawn routed through `BackendRegistry.get(agentDef.backend).factory`,
exactly as in SPEC-3; the lifecycle decides *which* agent profile + skill bundle + prompt
template each phase uses, and *chains* them with checkpoints.

**Done (v0.4):** `/fleet-implement <task>` runs the full superpowers pipeline via subagents
with inline phase tracking. Checkpointed by default; `--auto` for fire-and-forget. The
`/fleet` Lifecycle view shows active + recent lifecycles with phase timelines + artifact
links. The agent can self-orchestrate via `subagent({ task, lifecycle: "default" })`.

## 2. Architecture — lifecycles as phase-injection above the engine

### 2.1 Three registries, one engine

- **Agent registry** (SPEC-1, **unchanged** — no new agent frontmatter field): `general-purpose`
  + user-authored agents. `backend` (SPEC-3) still routes a single run; a lifecycle phase reads
  it via the phase's resolved agent. Lifecycle **selection is at call time** (Q5=A): the caller
  passes `lifecycle` to `subagent` / `/fleet-implement --lifecycle`. Per-phase agent pins live
  in the **lifecycle file** (`phase.agent`, §5.1) — the lifecycle defines which agent fills
  each phase, not the other way around. Agents are unchanged; they're merely *referenced* by
  lifecycle files.
- **Lifecycle registry** (SPEC-4 NEW): `default` builtin + user-authored. Project
  `.pi/lifecycles/*.md` overrides global `~/.pi/agent/lifecycles/*.md` (same precedence
  convention as agents). Each lifecycle file declares its phases, per-phase skill bundles,
  prompt templates, and optional per-phase default backend/agent + a lifecycle-wide
  default backend.
- **Backend registry** (SPEC-3, unchanged): `pi` / `claude` factories. The lifecycle never
  touches it directly — it resolves a backend per phase via the phase's agent-profile
  `backend` field (Q4=C).

### 2.2 The creation seam is unchanged

SPEC-1's `ChildSessionFactory` (`create(opts) => {session, model}`) is the backend-agnostic
creation seam. SPEC-3 wrapped it in a `BackendRegistry` mapping a backend id → a `Backend`
descriptor holding the factory + metadata. **SPEC-4 adds nothing to this seam.** Every
phase is a normal `subagent` spawn: the engine resolves the phase's agent → reads that
agent's `backend` (or a per-phase override) → `registry.get(backend).factory` → `ChildSession`.
The lifecycle's only engine footprint is *which* agent + skills + prompt each phase uses, and
*chaining* the phases.

### 2.3 Entry points (all funnel to one engine path)

- **Human (interactive-first):** `/fleet` panel → **Lifecycle view** → "Run lifecycle…"
  action (inline `Input` for task + lifecycle picker). The `/fleet-implement <task>` slash is
  the done-bar shortcut (defaults to the `default` lifecycle; `--lifecycle <name>` to
  select; `--auto` for fire-and-forget).
- **Agent (model-callable):** `subagent({ task, lifecycle: "default" })` — the existing
  `subagent` tool grows **one optional param** (`lifecycle?: string`). `lifecycle` absent ⇒
  single phaseless run (SPEC-1/2/3 behavior, fully backward-compatible). `lifecycle` present
  ⇒ lifecycle run.

### 2.4 What does NOT change (the undisturbed seam)

`ChildSessionFactory`, `ChildSession`, `ChildSessionEvent`, `BackendRegistry`, `Backend`
descriptor, the `subagent` tool's single-run path, the spawn lifecycle (SPEC-1 §5), the
guards (todo-excluded, concurrency=1, turn budget, Esc-abort), the Pi/CC factories,
`detectClaude`, the memory-hydrate / vision / todo-sync modules. SPEC-4 is purely
*additive above* the existing engine — a registry, a phase loop, a view, one optional tool
param.

## 3. Decision log (brainstorm 2026-07-24 — 7 Q&A, locked)

**Q1 — How do lifecycle phases map to execution?** → **B.** Phase = behavior/skill bundle;
no predetermined role library. Users *may* pin an agent per phase (`lifecycle: { plan:
my-planner }`); default = `general-purpose` + phase skill bundle. The superpowers skill set
*is* the role canon; naming them as fixed agents would reify the taxonomy SPEC-1 §7.3
explicitly rejected.

**Q2 — Autonomy vs checkpoints?** → **C.** Default **checkpointed** (Continue/Revise at each
phase boundary). `auto: true` / `--auto` escapes to fire-and-forget. Intra-phase
verification (skill-internal checks like `verification-before-completion` running tests)
still happens even in `auto` — `auto` only collapses the *human* inter-phase gate, not the
skill's own checks.

**Q3 — Where does the lifecycle definition live?** → **B.** Lifecycle registry:
`lifecycles/` (project `.pi/lifecycles/` + global `~/.pi/agent/lifecycles/`), mirroring the
agent registry. `default` = superpowers-5 builtin; users author alternatives (`quick`,
`security-audit`). Lifecycle **selection is at call time** (Q5=A — the caller passes `lifecycle`
to `subagent` / `/fleet-implement`); per-phase agent pins live in the **lifecycle file**
(`phase.agent`). Per-phase skill bundle is a **merge** (lifecycle skills ∪ the selected
agent's own `skills` frontmatter). This is the runway SPEC-6 workflows-as-code generalizes.

**Q4 — How does a lifecycle route across backends?** → **C.** Default **single-backend**
(coherent artifact chain); per-phase `backend:` override for explicit cross-arsenal phases.
The SPEC-3 `BackendRegistry` seam is undisturbed (phases still route through
`registry.get(agentDef.backend).factory`). Lifecycle-wide default backend resolution is
folded into Q5.

**Q5 — Entry-point surface + default backend?** → **A.** Extend `subagent` with an optional
`lifecycle: <name>` param (backward-compatible; absent ⇒ single run). Human surface = `/fleet`
Lifecycle view + "Run lifecycle" action + `/fleet-implement <task>` slash, all funneling to
the same engine entry. Default backend = lifecycle file top-level `backend:` → else `pi`
(always-available, never deadlocks on missing `claude`). Per-phase `backend:` overrides
per Q4=C.

**Q6 — Artifact chain + checkpoint mechanics?** → **B.** File-path handoff + summary. Each
phase records `(summary, producedPaths)`; phase N+1's prompt includes N's summary + paths,
and the N+1 child reads the real files with its `read` tool. Path-discovery via
**prompt-baked convention** (each phase's prompt template instructs the child to end its
`finalText` with an `Artifacts:` block listing paths; the engine parses it — works for all
phase types incl. read-only review, no FS coupling). Worktree-diff discovery recorded as a
SPEC-5a candidate. **Revise** = re-run phase N with human feedback appended, bounded
(`maxRevise = 3`).

**Q7 — armory-todo reflection?** → **C.** One TODO per lifecycle; phase sub-entries
(progress block) live in that TODO's `notes`; per-phase spawn calls inside a lifecycle
context **link to the parent lifecycle TODO** instead of creating their own (SPEC-1's
"link-when-intent-matches" policy applied: a phase's intent matches its lifecycle's). The
lifecycle TODO's notes are the single source of truth the Lifecycle view renders.
Standalone `subagent({ task })` unchanged.

## 4. Components (file layout — additions/changes vs SPEC-3)

```
src/
├── lifecycle/                      NEW  lifecycle engine (additive, above the spawn seam)
│   ├── lifecycle-types.ts          NEW  Lifecycle / Phase / PhaseRecord / RunRecord types
│   ├── registry.ts                 NEW  lifecycle registry + loader (project-over-global)
│   ├── default.ts                  NEW  the `default` builtin lifecycle (frontmatter + templates)
│   ├── prompt-template.ts         NEW  render phase templates with {task, prev, feedback, …}
│   ├── artifacts-parser.ts        NEW  parse the trailing `Artifacts:` block from finalText
│   ├── run-lifecycle.ts           NEW  the phase loop (resolve → spawn → checkpoint → advance)
│   └── lifecycle-todo.ts          NEW  lifecycle-level TODO create/link + progress-block updates
├── engine/
│   └── spawnSubagent.ts            MOD  +lifecycle-context option: when set, the link-or-create
│                                        TODO policy targets the parent lifecycle TODO instead
│                                        of creating a new task. Spawn itself unchanged.
├── tools/
│   └── subagent.ts                 MOD  +optional `lifecycle?: string` param; absent ⇒ unchanged
│                                        single-run path; present ⇒ routes to runLifecycle.
├── ui/
│   └── lifecycle-view.ts           NEW  the /fleet Lifecycle tab (list + phase timeline + checkpoint)
├── registry/agents/ builtins
│   └── (no new role agents — Q1=B; general-purpose stays the only builtin)
└── index.ts                        MOD  wire lifecycle registry + view; register /fleet-implement slash

specs/SPEC-4-superpowers-native-lifecycle.md   THIS FILE
plans/SPEC-4-superpowers-native-lifecycle.md   (next: writing-plans)
scripts/spec-4-smoke.mts                        NEW  real end-to-end lifecycle smoke (real Ollama pi phases)
test/lifecycle-registry.test.mts                NEW
test/prompt-template.test.mts                  NEW
test/run-lifecycle.test.mts                     NEW
test/artifacts-parser.test.mts                  NEW
test/lifecycle-todo-sync.test.mts               NEW
test/subagent-lifecycle-param.test.mts          NEW
```

**Net:** ~7 new source files, ~3 modified (`spawnSubagent.ts`, `subagent.ts`, `index.ts`),
1 builtin lifecycle, 1 smoke script, 6 test files. No existing source module's *behavior*
changes — `subagent.ts` adds a param (backward-compatible), `spawnSubagent.ts` adds an
*option* (backward-compatible), `index.ts` wires the new surface. All SPEC-1/2/3 tests
must pass unchanged (regression guard).

## 5. The lifecycle file format + the `default` builtin

### 5.1 File format (mirrors the SPEC-1 agent-registry pattern)

A lifecycle file is **YAML frontmatter + a markdown body**. The frontmatter holds
lifecycle-level + per-phase config; the body uses `## <phaseName>` H2 headings to delimit
each phase's prompt template.

```md
---
name: default                      # unique id; default = filename
description: The superpowers-native 5-phase lifecycle.
backend: pi                        # lifecycle-wide default backend; absent → pi
phases:
  - name: brainstorm
    skills: [brainstorming]         # injected into the phase child (merged with agent's)
    agent: general-purpose          # optional per-phase default agent; absent → general-purpose
    backend: pi                     # optional per-phase override (Q4=C); absent → lifecycle.backend
    checkpoint: true                # pause for human review after this phase; default true
  - name: plan
    skills: [writing-plans]
    checkpoint: true
  - name: implement
    skills: [executing-plans, test-driven-development, verification-before-completion]
    checkpoint: false               # review runs next; the review IS the gate
  - name: review
    skills: [requesting-code-review, receiving-code-review]
    checkpoint: true
  - name: finish
    skills: [finishing-a-development-branch]
    # terminal phase — no checkpoint after it (lifecycle is done)
---

## brainstorm
You are the **brainstorm** phase of a superpowers lifecycle. Use the brainstorming skill.
Task: {{task}}
{% if prev %}Previous phase ({{prev.name}}) produced: {{prev.summary}}
Artifacts to read: {{prev.paths}}{% endif %}
Produce a design doc per the skill, end your response with an `Artifacts:` block listing produced file paths.

## plan
You are the **plan** phase. Use writing-plans. Read the brainstorm's design artifact.
{% if prev %}Previous phase: {{prev.summary}} | Artifacts: {{prev.paths}}{% endif %}
{% if feedback %}Human feedback on a prior attempt: {{feedback}}{% endif %}
Write the implementation plan, end with an `Artifacts:` block.

## implement
You are the **implement** phase. Use executing-plans + TDD + verification-before-completion.
Read the plan artifact. Implement it, run tests, verify before claiming done.
End with an `Artifacts:` block (files changed).

## review
You are the **review** phase. Use requesting-code-review + receiving-code-review.
Review the implementation against the plan + design. Produce review findings.
End with an `Artifacts:` block (review notes path).

## finish
You are the **finish** phase. Use finishing-a-development-branch.
Decide merge/PR/cleanup per the skill, execute it. End with an `Artifacts:` block (or omit
on a merge/PR that has no further file artifact — terminal-phase exemption, §7.2).
```

### 5.2 Template variables

| Variable | Meaning |
|---|---|
| `{{task}}` | The original task (from `/fleet-implement <task>` or `subagent({ task, lifecycle })`) |
| `{{prev.name}}` / `{{prev.summary}}` / `{{prev.paths}}` | The previous phase's record (absent on phase 1) |
| `{{feedback}}` | On **Revise** only: human feedback + a digest of prior attempts |
| `{{lifecycle}}` / `{{phase}}` | Self-reference (lifecycle name / current phase name) |

`{{prev.paths}}` renders as a newline-separated list of `- <path>` lines. `{{feedback}}`
renders the human's Revise text + a digest of the prior attempts' summaries (so the child
sees what it tried before and why the human asked to revise).

### 5.3 The `default` lifecycle's 5 phases + skill bundles (the shipped builtin)

| # | Phase | Skills injected | Checkpoint after? | Why this skill bundle |
|---|---|---|---|---|
| 1 | brainstorm | `brainstorming` | ✅ (design gate) | The skill IS the phase behavior — it drives Q&A→design→spec with its HARD-GATE |
| 2 | plan | `writing-plans` | ✅ (plan gate) | Produces the implementation plan from the design artifact |
| 3 | implement | `executing-plans` + `test-driven-development` + `verification-before-completion` | ❌ (review runs next) | Execute the plan with TDD discipline; verify (run tests) before claiming done — the review phase is the gate, not a human checkpoint here |
| 4 | review | `requesting-code-review` + `receiving-code-review` | ✅ (review-decision gate) | Request + receive a code review of the implementation; human decides Revise (re-run implement) or Continue (→ finish) from the review findings |
| 5 | finish | `finishing-a-development-branch` | ❌ (terminal) | Merge/PR/cleanup per the skill; lifecycle is done |

### 5.4 Design choices baked in

- **Checkpoint at implement = false.** The implement→review transition is automated: the
  review phase *is* the gate, so a human checkpoint between them would be redundant. The
  human's decision point comes *after* review (Continue to finish, or Revise → re-run
  implement with the review feedback). This matches superpowers — the review skill is the
  automated gate, the human gate is the review-decision.
- **`verification-before-completion` in implement, not review.** The worker verifies its
  own work (runs tests) before handing off; the review phase stays focused on code-review.
  Avoids the skill appearing in two phases.
- **`systematic-debugging` is NOT in the default bundle.** It's a fallback skill (loaded
  when debugging is needed), not a default phase discipline. Users add it to a custom
  lifecycle or pin it per-phase. Keeps the default lean.
- **`using-git-worktrees` is NOT in the default bundle.** Worktree isolation is SPEC-5a's
  scope. SPEC-4's finish phase operates on the current workspace; worktree-isolated
  lifecycle runs land in SPEC-5a.
- **Skills are a merge, not a replace.** The phase loads the lifecycle's phase skills ∪ the
  selected agent's own `skills` frontmatter. Merge precedence: lifecycle phase skills first,
  then agent's own (so an agent can't accidentally drop a phase-required skill; it can only
  add). An agent that preloads `test-driven-development` keeps it in every phase it's
  pinned to.

## 6. The phase loop (runtime core — `run-lifecycle.ts`)

### 6.1 The loop

```
runLifecycle(task, lifecycleName, opts):
  1. Resolve lifecycle = registry.get(lifecycleName)
     → validate frontmatter + parse body into phase templates.
     Resolve-time errors (missing/bad file, unknown phase, malformed template) abort here
     with an actionable message (§9).
  2. Create/link the lifecycle TODO (SPEC-1 policy applied at lifecycle level): link to a
     matching open TODO if one exists, else create a `fleet` project task. Stash its id as
     lifecycleTodoId. Initialize its notes with an empty phase-progress block:
       Lifecycle: default · task: "<task>"
       Backend: pi · Mode: checkpointed
       Phases: [ ] brainstorm  [ ] plan  [ ] implement  [ ] review  [ ] finish
  3. For each phase in lifecycle.phases:
     a. Resolve agent: phase.agent (per-phase pin in the lifecycle file) → `general-purpose`.
     b. Resolve backend: phase.backend → lifecycle.backend → `pi`.   (Q4=C, Q5)
        If a phase explicitly requests `claude` and detectClaude() is false → resolve-time
        error (§9); never silently fall back to `pi` for a phase that asked for `claude`.
     c. Resolve skills: merge(lifecycle.phase.skills, agent.skills).   (Q3=B merge)
     d. Build prompt: render phase template with {task, prev?, feedback?, lifecycle, phase}.
        - prev = previous phase's (summary, paths) — absent on phase 1.
        - feedback = on Revise only: human feedback + digest of prior attempts.
     e. Spawn the phase child via the UNCHANGED path:
          subagent spawn → BackendRegistry.get(backend).factory → ChildSession
        with a lifecycle-context flag (lifecycleTodoId) so the spawn's link-or-create TODO
        policy LINKS TO lifecycleTodoId instead of creating a new task (Q7=C).
        Concurrency=1, todo-excluded, Esc-abort — all SPEC-1 guards carry through unchanged.
     f. Child runs, returns finalText (run status per SPEC-1 §4.3).
     g. If run status = `failed` → force a checkpoint (§9) regardless of auto/checkpoint.
        Else parse finalText's trailing `Artifacts:` block → (summary, paths). Record on
        the phase record. If the phase is non-terminal and the Artifacts block is missing/
        malformed → phase failure → force a checkpoint (§9).
     h. Update lifecycleTodoId notes: mark this phase `[x]`, update the status line.
        (Single source of truth; the /fleet Lifecycle view reads this block.)
     i. CHECKPOINT (unless opts.auto OR phase.checkpoint === false):
          pause. Surface to /fleet Lifecycle view. Await human: Continue | Revise | Abort.
          - Continue → proceed to next phase.
          - Revise → increment phase.reviseCount; if > maxRevise (3) → fail the lifecycle (§9);
            else re-run THIS phase (go to a–g) with feedback appended to the prompt.
          - Abort → mark lifecycle aborted, restore lifecycleTodo to open (not orphaned).
        If opts.auto OR phase.checkpoint === false → advance to the next phase (no pause),
        UNLESS the phase failed (failure forces a checkpoint regardless, §9).
     j. If phase is terminal (last in lifecycle) → mark lifecycle completed,
        lifecycleTodo → done.
```

### 6.2 Checkpoint state machine (per phase)

| Current state | Trigger | Result |
|---|---|---|
| phase child returned (success) + `checkpoint=true` + not `auto` | Human: **Continue** | Advance to next phase |
| phase child returned (success) + `checkpoint=true` + not `auto` | Human: **Revise** (with feedback text) | Re-run this phase with `[task] + [prior summary] + [feedback]`; `reviseCount++`; if `>3` → lifecycle `failed` |
| phase child returned (success) + `checkpoint=true` + not `auto` | Human: **Abort** (or Esc) | Lifecycle status `aborted`; lifecycleTodo restored to **open** (SPEC-1 §9.4 Esc-abort semantics) |
| phase child returned (success) + `checkpoint=false` | — (no pause) | Advance automatically |
| phase child returned (success) + `checkpoint=true` + `auto=true` | — (no pause) | Advance automatically (intra-phase verification already ran inside the child per Q2=C) |
| phase child **failed** (run status `failed`) | — | Force a checkpoint regardless of `auto`/`checkpoint`: human sees the error, Revise or Abort (Continue disabled) |

### 6.3 Concurrency (SPEC-1 §9.2 inherited)

One child session at a time. During a lifecycle's phase run, the `subagent` tool is busy —
no other `subagent` call (lifecycle or single) can start until the phase completes.
**Between phases** (at a checkpoint) the tool is free, so the human can start a second
lifecycle; its first phase run queues until the other lifecycle is between phases. True
concurrent *child sessions* → SPEC-5a. The constraint is one concurrent **child session**,
not one concurrent **lifecycle**.

## 7. Artifact chain + Revise (Q6=B, concrete)

### 7.1 The `Artifacts:` block

Each phase's prompt template instructs the child to **end its `finalText`** with an
`Artifacts:` block:

```
Artifacts:
  - path: docs/superpowers/specs/2026-07-24-feature-x-design.md
    kind: design
  - path: plans/feature-x.md
    kind: plan
```

The engine parses this block (a YAML block under an `Artifacts:` line — exact grammar
pinned in `artifacts-parser.ts`). The phase record stores `(name, summary, paths, status,
reviseCount)`. The **next phase's prompt** gets `prev.summary` + `prev.paths` so the child
can `read` the real files.

### 7.2 Terminal-phase exemption

The terminal phase (`finish`) may legitimately omit the `Artifacts:` block (a merge/PR has
no further file artifact). The parser exempts the terminal phase from the missing-block
failure. All non-terminal phases must produce a parseable `Artifacts:` block or the phase
is treated as failed (§9).

### 7.3 Revise

Re-running a phase (Revise) appends the human feedback + a digest of prior attempts to the
prompt: `[task] + [prior attempt's summary] + [human feedback: …]`. The child produces a
new artifact, **replacing** the old phase record (the old artifact files remain on disk; the
chain points at the new ones). `reviseCount` increments; if it exceeds `maxRevise = 3`, the
lifecycle is marked `failed` (§9).

## 8. TODO-sync for lifecycles (Q7=C, concrete)

- **Lifecycle start:** create/link one armory-todo task (the lifecycle's intent). Its
  `notes` get a phase-progress block — the single source of truth:
  ```
  Lifecycle: default · task: "implement feature X"
  Backend: pi · Mode: checkpointed
  Phases: [x] brainstorm  [x] plan  [ ] implement  [ ] review  [ ] finish
  Last: plan completed — plan written to plans/feature-x.md
  ```
- **Per-phase spawn:** the spawn path's link-or-create detects the lifecycle context
  (lifecycleTodoId) and **links to `lifecycleTodoId`** instead of creating a new task. The
  phase run is reflected *inside* the lifecycle TODO (via the progress block), never
  orphaned, never flooding the top-level list.
- **Phase advance:** engine updates the notes' progress block (mark `[x]`, update Last
  line). The `/fleet` Lifecycle view reads the same notes block — single source of truth.
- **Revise:** notes' progress block shows `[~] <phase> (revising, attempt N/3)`.
- **Completion:** lifecycle TODO → done. **Abort:** lifecycle TODO → restored to open (not
  orphaned — the human can re-run or close manually).
- **Standalone `subagent({ task })`** (no lifecycle param): SPEC-1/2/3 behavior unchanged —
  creates/links its own TODO, no lifecycle context.

## 9. The `/fleet` panel — Lifecycle view

Per the getpither interactive-first convention, the Lifecycle capability lands as a **new
tab in the `/fleet` panel** first (human surface); the model-callable surface is the
`subagent({ task, lifecycle })` param (§2.3). The `/fleet-implement <task>` slash is the
thin text mirror / done-bar shortcut.

### 9.1 Panel structure — one new tab

`/fleet` (no-arg) opens the existing full-screen `ctx.ui.custom()` component. Tabs today:
**Fleet** | **Agents** | **Backends** (SPEC-1/2/3). SPEC-4 adds: **Lifecycle**. Tab order:
Fleet → Lifecycle → Agents → Backends (Lifecycle adjacent to Fleet since both are
run-centric; Agents/Backends are config-centric).

### 9.2 Lifecycle tab — the list view

Rows = active + recent lifecycles (read from the lifecycle run records + the armory-todo
progress blocks):

```
▶ fl-2kp9xa  default  ●implement 3/5  checkpointed  14m  pi  "implement feature X"
⏸ fl-4mn7qb  default  ●review   4/5  checkpointed  22m  pi  "fix off-by-one in parser"
✓ fl-8pq1lc  default  ●finish   5/5  done         31m  pi  "add /fleet-implement tool"
✗ fl-3xr2tw  default  ●implement 3/5  failed        9m  pi  "refactor state machine"
```

| Column | Meaning |
|---|---|
| status glyph | `▶` active · `⏸` paused at checkpoint · `✓` done · `✗` failed/aborted |
| id | `fl-<id>` (fleet run id namespace, same as SPEC-1) |
| lifecycle | lifecycle name (`default`, `quick`, …) |
| current phase + N/M | `●implement 3/5` (filled dot = current; counts include revises) |
| mode | `checkpointed` / `auto` |
| elapsed | since lifecycle start |
| backend | `pi` / `claude` (lifecycle-wide, per Q4/Q5) |
| task | truncated task string |

### 9.3 Lifecycle detail (row selected) — the phase timeline + checkpoint prompt

Selecting a row expands the phase timeline below the list (split pane — matches the
Backends-view detail pattern):

```
Lifecycle fl-4mn7qb — default — "fix off-by-one in parser"
Backend: pi · Mode: checkpointed · Status: ⏸ checkpoint at review

Phases:
  [x] brainstorm   ✓ design → docs/.../off-by-one-design.md        [Open]
  [x] plan         ✓ plan → plans/off-by-one.md                   [Open]
  [x] implement    ✓ code → src/parser.ts (8 tests pass)          [Open]
  [~] review       ⏸ completed — awaiting your decision            [Open]
  [ ] finish

── Checkpoint: review phase returned ──
Summary: "Reviewed src/parser.ts against plan. Found 1 issue: edge case at
EOF not handled (plan step 4 incomplete). Artifacts: review/off-by-one-review.md"
Feedback for Revise (or Continue to finish):
> [_______________________________________________________]
  [Open artifacts]  [Continue]  [Revise]  [Abort]
```

- `[x]` done · `[~]` current/awaiting · `[ ]` pending
- `[Open]` opens the phase's artifact file in the editor (clickable path from the
  `Artifacts:` block)
- At a checkpoint: a single-line `Input` for Revise feedback (pi-tui constraint: no nested
  `ctx.ui.editor()` inside `ctx.ui.custom()`), plus the action submenu below

### 9.4 Action submenu (context-sensitive — per getpipher convention)

| Context | Actions |
|---|---|
| **On the Lifecycle tab, no row focused** | `Run lifecycle…` (opens task `Input` + lifecycle picker, default `default`) · `Refresh` |
| **On a lifecycle row (not at checkpoint)** | `Info` (full phase timeline) · `Abort` (→ aborted, lifecycle TODO restored open) · `Delete` (archive record) |
| **At a checkpoint (⏸)** | `Open artifacts` (opens the phase's files) · `Continue` (→ next phase) · `Revise…` (prompts for feedback via inline `Input`, → re-run this phase) · `Abort` |
| **On a completed lifecycle (✓)** | `Re-run` (new lifecycle, same task+lifecycle) · `View artifacts` · `Delete` |
| **On a failed lifecycle (✗)** | `View failure` (error summary + last phase) · `Revise…` (re-run the failed phase with feedback) · `Abort` (confirm) · `Delete` |

`Run lifecycle…` flow: inline `Input` for the task → inline `Input` / list-picker for the
lifecycle name (defaults to `default`) → optional `--auto` toggle → engine starts the
lifecycle, row appears with `▶` status.

### 9.5 EditorTheme gotcha (carried from AGENTS.md)

The Lifecycle view is a `ctx.ui.custom()` panel → its factory receives the **full `Theme`**.
But per the v0.2.1 cursor crash lesson, the safe pattern is to **thread `() => ctx.ui.theme`**
(live getter) for real colors rather than caching the factory's `theme` arg, so theme
switches reflect live. The status glyphs (`▶⏸✓✗`), phase markers (`[x][~][ ]`), and any
coloring use `ctx.ui.theme.getFgAnsi(...)`. This is the same discipline the Backends view
(SPEC-3) already follows; SPEC-4's Lifecycle view inherits it.

## 10. The `subagent` tool — the `lifecycle` param

The existing `subagent` tool (SPEC-1 §4) grows **one optional param**:

| Param | Type | Default | Behavior |
|---|---|---|---|
| `lifecycle` | `string?` | absent | Absent ⇒ single phaseless run (SPEC-1/2/3 unchanged). Present ⇒ lifecycle run: `runLifecycle(task, lifecycle, opts)` where `opts.auto` comes from a sibling `auto?` param (default `false`). |

The `auto?: boolean` companion param (default `false`) toggles the checkpoint model (Q2=C).
Both params are optional and backward-compatible — every existing `subagent({ task })` call
is unchanged.

Slash mirror: `/fleet-implement <task>` (done-bar) → `runLifecycle(task, "default", {auto:
false})`. `--lifecycle <name>` selects; `--auto` sets `auto: true`. The slash is a thin text
mirror of the panel's "Run lifecycle…" action (per getpipher convention, slash subs are thin
mirrors or omitted — kept here because the PRD §8 done-bar names it explicitly).

## 11. Guards (SPEC-1/2/3 §9 carried forward)

- **todo excluded from child tools** (SPEC-1 §9.1): unchanged. Lifecycle phase children
  don't call `todo`; the engine manages the lifecycle TODO. Pi enforces via
  `excludeTools`/`--disallowed-tools`; CC via prompt-baking (SPEC-3 §9.1).
- **Concurrency=1** (SPEC-1 §9.2): inherited — one child session at a time (§6.3).
- **Turn budget** (SPEC-1 §9.3): unchanged per phase; the engine's `turn_end` belt is the
  guard for each phase run. `--max-turns` omitted for CC (SPEC-3 §4.5).
- **Esc-abort propagation** (SPEC-1 §9.4): unchanged; Esc on the parent wires to
  `child.abort()` → run status `aborted` → lifecycle `aborted` → lifecycle TODO restored open.

## 12. Error handling + failure modes

**Principle:** fail loudly, never silently (SPEC-1 §9 guards carry through). A phase failure
**forces a checkpoint** regardless of `auto`/`checkpoint` — the human sees the error and can
only **Revise** or **Abort** (Continue is disabled past a failure). No silent fallback, no
auto-skip.

| Failure mode | Handling |
|---|---|
| **Phase child returns `failed`** (run status per SPEC-1 §4.3) | Force a checkpoint. Human: Revise (re-run this phase with feedback) or Abort. Continue disabled. |
| **Phase returns success but no `Artifacts:` block** on a non-terminal phase | Treated as a phase failure → forced checkpoint (Revise/Abort). Terminal phase exempted (§7.2). |
| **Revise budget exhausted** (`reviseCount > 3`) | Lifecycle status → `failed`. Lifecycle TODO stays **open** (not done — the work isn't complete). Human can Re-run (new lifecycle) or manually close the TODO. |
| **Brainstorm phase can't produce a design** | Returns no Artifacts block → phase failure → forced checkpoint. Human: Revise (clarify the task) or Abort. Natural handling, no special case. |
| **Review phase finds blocking issues** | Not a failure — review *reports findings* (Artifacts = review notes). At the checkpoint, the human reads findings and chooses Continue (→ finish) or Revise (→ re-run implement with the review feedback). Review doesn't "reject"; it informs the human's Continue/Revise decision (Q2=C gate). |
| **Lifecycle file missing/malformed** (bad frontmatter, missing phase template, unknown phase name) | Fail at **resolve-time** with an actionable error: which file, which field, why. The lifecycle never starts. |
| **Lifecycle name not found** (`subagent({ task, lifecycle: "nope" })` / `/fleet-implement --lifecycle nope`) | Resolve-time error: `"lifecycle 'nope' not found; available: default, …"`. |
| **Backend unavailable** (per-phase `backend: claude` but `detectClaude` is false) | Resolve-time error: `"phase 'review' requests backend 'claude' but claude is not installed; run 'claude' to set up, or change the phase backend in the lifecycle file"`. Never silently falls back to `pi` for a phase that explicitly asked for `claude`. |
| **Esc-abort mid-phase** | SPEC-1 §9.4: `child.abort()` → run status `aborted` → lifecycle `aborted` → lifecycle TODO restored to **open**. |
| **Human Abort at a checkpoint** | Same as Esc-abort: lifecycle `aborted`, TODO restored open. |
| **Lifecycle TODO link-or-create fails** (armory-todo port error) | Lifecycle can't start — surface the armory-todo error to the caller (no silent fallback, no orphan runs). |
| **Auto mode + a phase fails** | `auto` only collapses **human inter-phase** gates (Q2=C). A failed phase forces a checkpoint regardless — `auto` never silently advances past a failure. |
| **EditorTheme crash class** (the v0.2.1 cursor lesson) | The Lifecycle view threads `() => ctx.ui.theme` (§9.5). The integration smoke inside real pi (per AGENTS.md gotcha guidance) catches any crash before the v0.4.0 tag. Unit tests use a fake theme; the term-driven TUI smoke uses real pi. |
| **Crash / pi restart mid-phase** | SPEC-4 lifecycle state is in-memory (the run record) + the **lifecycle TODO's notes progress block** (persists). On restart, an interrupted lifecycle is **not** auto-resumed (that's SPEC-5a async/bg); the TODO remains open with its last-known progress, and the human can Re-run or manually advance. Acceptable for v0.4; durable state + auto-resume is recorded for SPEC-5a. |

## 13. Testing (mirrors SPEC-1/2/3: `node --import tsx --test`, fake registries, no real LLM in unit tests)

| Suite | Coverage |
|---|---|
| `test/lifecycle-registry.test.mts` | Loader: parse frontmatter + body, project-over-global precedence, validation, all resolve-time error cases (missing file, bad frontmatter, unknown phase, malformed template). |
| `test/prompt-template.test.mts` | Render all variables (`task`, `prev.*`, `feedback`, `lifecycle`, `phase`); Revise feedback injection; missing-prev on phase 1; missing-feedback on first run. |
| `test/run-lifecycle.test.mts` | The phase loop with a fake `BackendRegistry` (fake factory → fake `ChildSession` emitting canned events + `finalText` with an `Artifacts:` block). Covers: normal advance through 5 phases; checkpoint Continue; checkpoint Revise (incl. budget exhaustion → `failed`); phase failure forces checkpoint (Continue disabled); `auto` mode skips human checkpoints but still forces on failure; terminal phase completes → lifecycle `done` + TODO done; Abort mid-phase + at checkpoint → TODO restored open; per-phase backend override; lifecycle-wide default backend → `pi` fallback. |
| `test/artifacts-parser.test.mts` | Well-formed `Artifacts:` block; malformed (missing/misaligned); missing entirely; terminal-phase exemption. |
| `test/lifecycle-todo-sync.test.mts` | Lifecycle start creates/links one TODO; per-phase spawn **links to the parent lifecycle TODO** (not creates new); progress block updates per phase advance + Revise; completion → done; abort → restored open. Fake todo port. |
| `test/subagent-lifecycle-param.test.mts` | `lifecycle` absent → single-run path unchanged (regression: existing SPEC-1/2/3 subagent tests still pass); `lifecycle` present → routes to `runLifecycle`. |

**Smoke scripts (real backends, gated):**
- `scripts/spec-4-smoke.mts` — runs a real lifecycle end-to-end on a trivial task ("add a
  `hello()` function to a scratch file") using real Ollama Cloud pi phases
  (brainstorm→plan→implement→review→finish), verifying the full artifact chain + TODO
  progress. CC phase runs if `claude` is present + authed (RECTOR's OAuth is expired — skip
  CC rows gracefully per the SPEC-3 smoke pattern, don't fail).
- Term-driven TUI smoke (per SPEC-3 pattern): install the published
  `@getpipher/armory-fleet@0.4.0` into pi, `/reload`, `/fleet`, `tab` to Lifecycle, render
  the list + a checkpoint detail — verifies the extension-load + TUI render path + no
  EditorTheme crash.

**CI gate:** `pnpm typecheck && pnpm test:run` — existing 107 tests (unchanged behavior, no
regressions) + new SPEC-4 suites.

## 14. Deferred (recorded, with landing SPEC)

| Deferred item | Landing SPEC | Why deferred |
|---|---|---|
| Worktree isolation per phase/lifecycle | SPEC-5a | `using-git-worktrees` is NOT in the default lifecycle; SPEC-5a owns the worktree lifecycle |
| Async/background lifecycles + durable state + auto-resume after crash | SPEC-5a | SPEC-4 state is in-memory + TODO notes (manual recovery) |
| Concurrent child sessions (multiple phases running at once) | SPEC-5a | Concurrency=1 inherited (one child at a time) |
| Worktree-diff artifact discovery | SPEC-5a candidate | SPEC-4 uses the prompt-baked `Artifacts:` block (works for all phase types incl. review) |
| Mid-run steering (inject a message into a running phase child) | SPEC-5b | SPEC-4 steering is inter-phase (Continue/Revise/Abort at checkpoints), not intra-phase |
| Conversation viewer (live-scrolling phase output) | SPEC-5b | SPEC-4 shows phase summaries + artifacts, not live streaming |
| Cost-aware per-phase model tiering / quality gates (judgePanel, loopUntilDry, completenessCheck, gate, checkpoint) | SPEC-6 | SPEC-4 lifecycle is the runway, not the cost engine |
| Workflows-as-code (JS orchestration with `agent`/`parallel`/`pipeline`/`phase` + journaled resume) | SPEC-6 | Lifecycle registry is the runway; the workflow engine is SPEC-6's job |
| Event-bus + cross-extension RPC (other extensions observe/steer lifecycles) | SPEC-6 | Composability surface is SPEC-6 |
| `systematic-debugging` in the default lifecycle | — (user can add) | Fallback skill, not a default phase discipline |
| Custom lifecycle authoring tooling (a `/fleet` editor for lifecycle files) | — | Users author lifecycle files directly (markdown + frontmatter, same as agent files) |

## 15. Done bar (v0.4, from PRD §8)

`/fleet-implement <task>` runs the full superpowers pipeline via subagents with inline phase
tracking. Checkpointed by default (Continue/Revise at each gate); `--auto` for
fire-and-forget. The `/fleet` Lifecycle view shows active + recent lifecycles with phase
timelines + artifact links. The agent can self-orchestrate via
`subagent({ task, lifecycle: "default" })`.