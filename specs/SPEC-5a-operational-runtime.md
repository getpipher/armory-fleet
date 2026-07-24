# SPEC-5a — Operational runtime (async/bg + scheduling + git-worktree isolation)

> **Status:** SPEC (brainstorm output, pre-plan) · **Owner:** RECTOR · **Created:** 2026-07-24
> **Package:** `@getpipher/armory-fleet` · **Target release:** v0.5a · **Compatibility:** pi `^0.81.1`
> **Pipeline position:** 6th of 9 phases (PRD + research + SPEC-1..4 done; this spec → plan → implementation → v0.5a)

---

## 1. Overview & goals

SPEC-5a makes the fleet **operational**: runs can fire without being awaited, parallel edits don't conflict, work survives a crashed pi, and recurring work can be scheduled. It layers three capabilities **above the unchanged SPEC-1..4 engine seam** (`ChildSessionFactory` / `BackendRegistry` / `runLifecycle` — untouched, per the carry-forward discipline):

1. **Async/background runs** — fire a subagent or lifecycle without awaiting; runs in an isolated git worktree; a durable journal records progress; a crashed pi auto-resumes interrupted runs on next project open.
2. **Scheduling** — cron / interval / one-shot schedules, session-scoped and PID-locked, fired in-process.
3. **Git-worktree isolation** — one worktree per async/bg lifecycle, auto-committed to a branch on completion; worktree-diff discovers phase artifacts structurally (replaces the fragile prompt-baked `Artifacts:` block for isolated runs).

**Goals:**
- Background parallel agents on isolated worktrees — parallel edits never conflict.
- Schedule recurring or one-shot subagents from the `/fleet` panel or the `subagent` tool.
- A killed/crashed pi mid-lifecycle is not lost work — resume on next open.
- Completed bg runs auto-deliver to the parent agent via a bounded inbox + `fleet.results()` tool.

**Non-goals (deferred, recorded in §14):**
- FleetView navigable list, live widget, conversation viewer, mid-run steering → **SPEC-5b**.
- Cost-aware tiers, quality gates, workflows-as-code, event-bus/RPC → **SPEC-6**.
- Cross-reboot daemon (runs surviving pi exit as an independent process) → rejected (Q1=B); session-bound process + durable state is the chosen model.

---

## 2. Architecture — operational layer above the engine

### 2.1 Three new modules, one unchanged seam

| Module | Path | Role |
|---|---|---|
| WorktreeService + DiffService | `src/worktree/` (greenfield) | create/remove a git worktree per run; diff a worktree vs base to discover phase artifacts; commit the worktree to a branch on completion |
| Cron parsing | `src/vendor/cron-parser/` (vendored MIT, frozen) | parse a cron expression → next `Date` after a given time |
| Async runtime + journal + resume + inbox | `src/runtime/` | the N-slot bg concurrency pool; the JSONL run journal (append + replay); resume detection on pi start; the results inbox |
| Scheduling | `src/scheduling/` | schedule registration, in-process timer, PID-lock, next-fire computation |

The **creation seam** (`ChildSessionFactory` / `BackendRegistry` / `runLifecycle`) is **unchanged**. SPEC-5a layers above it: the async runner calls `runLifecycle` (or `spawnSubagent` for single delegates) with a worktree cwd + a journal hook; it does not modify the phase loop, the backend registry, or the spawn path. This is the same discipline SPEC-3 (backends) and SPEC-4 (lifecycles) followed — layer above, don't touch the seam.

### 2.2 Entry points

All three funnel through the async runtime, which calls the unchanged engine:

| Caller | Surface | Path |
|---|---|---|
| Agent (programmatic) | `subagent({ task, background?: boolean, schedule?: string, lifecycle?: string, auto?: boolean })` | background=true → async runtime → worktree + `runLifecycle`/`spawnSubagent` |
| Agent (results pull) | `fleet.results({ runId? })` | reads the results inbox |
| Human (interactive) | `/fleet` → `scheduled` tab; `fleet` tab bg rows | panel → async runtime |
| Human (slash mirror) | `/fleet-schedule <task> <expr> [--lifecycle <name>] [--auto]` | thin → scheduling |
| Timer (scheduled fire) | in-process scheduler | → async runtime (same as background=true) |

### 2.3 What does NOT change (the undisturbed seam)

- `runLifecycle` phase loop, checkpoint state machine, `Artifacts:` parser for **foreground** runs (Q3=A).
- `ChildSessionFactory`, `BackendRegistry`, `spawnSubagent`, the single-slot foreground lock.
- The `/fleet` `lifecycle` / `agents` / `backends` tabs.
- Foreground sync `subagent` behavior — unchanged from v0.4 (Q2=A: no breaking change).

---

## 3. Decision log (brainstorm 2026-07-24 — 9 Q&A, locked)

| Q | Topic | Decision | Rationale (condensed) |
|---|---|---|---|
| Q1 | Process / state model | **B** — session-bound process + durable state + auto-resume | matches the handoff reconciliation goal; avoids the daemon process-management rabbit hole; durability is state, not process |
| Q2 | Worktree isolation scope + granularity | **A** — per-lifecycle, async/bg-only; foreground unchanged | matches PRD "isolation for parallel edits" + SPEC-4 §5.4; zero breaking change to v0.1..0.4 foreground; phases sharing a tree is a feature |
| Q3 | Artifact discovery | **A** — worktree-diff for isolated, prompt-baked for foreground | structural diff is robust to models that omit the `Artifacts:` block (today's smoke failure mode); foreground has no worktree to diff |
| Q4 | Concurrency model | **A** — two pools: foreground single-slot (unchanged), async/bg N-slot default 3 configurable | preserves SPEC-1 invariant; foreground never starved by bg; bounded for rate limits; clean SPEC-6 cost-aware extension point |
| Q5 | Scheduling | **A** — cron + interval + one-shot; `/fleet` scheduled tab + `subagent({schedule})` tool + thin slash; PID-locked; no catch-up | covers all three PRD expression types; interactive-first (panel primary); honest about session-scoped (no catch-up) |
| Q6 | Auto-delivery | **C** — notify + results inbox + `fleet.results()` tool + bounded hint | genuine delivery without intruding on the parent's live turn; durable record stays in TODO notes + journal |
| Q7 | Durable state format | **A** — JSONL journal per run, append-only, replay-on-resume; schedules in `schedules.json` | most crash-safe by construction; the event log IS the `i:Info` timeline; foundation for SPEC-6 journaled workflows |
| Q8 | TUI surface | **A** — minimal: `scheduled` tab + bg status icons on `fleet` rows; no live widget | minimal-but-complete for the operational runtime; live widget / conversation viewer is SPEC-5b |
| Q9 | Vendored plumbing | **A** — vendor `cron-parser` (MIT), write worktree lifecycle greenfield | cron is commodity (fiddly, battle-tested); worktree-add is a thin git shell-out not worth a git library |

---

## 4. Components (file layout — additions/changes vs SPEC-4)

```
src/
├── worktree/                      # NEW — greenfield (Q9=A)
│   ├── worktree-service.ts        # add/remove/exists/branch — git worktree shell-outs
│   ├── diff-service.ts            # diffPhase(runId) = tracked + untracked changes vs base
│   └── worktree-service.test.ts
├── vendor/
│   └── cron-parser/               # NEW — vendored MIT (Q9=A)
│       ├── index.js               # frozen copy of cron-parser
│       ├── NOTICE.md              # origin, version, date, MIT license, attribution
│       └── types.d.ts
├── runtime/                       # NEW
│   ├── async-runner.ts            # background=true path: worktree + runLifecycle + journal + inbox
│   ├── concurrency-pool.ts        # N-slot semaphore (default 3, fleet.maxConcurrentBg)
│   ├── run-journal.ts             # JSONL append + replay + partial-line-skip
│   ├── resume.ts                  # on pi start: scan .pi/fleet/runs/ for non-terminal journals
│   ├── results-inbox.ts           # in-memory queue of completed-run summaries + fleet.results()
│   └── *.test.ts
├── scheduling/                    # NEW
│   ├── scheduler.ts               # register/list/pause/resume/delete; in-process timer
│   ├── pid-lock.ts                # .pi/fleet/schedules.lock — only owning pi PID fires
│   ├── expressions.ts             # cron (vendored) / interval / one-shot → next-fire Date
│   └── *.test.ts
├── tools/
│   └── subagent.ts                # CHANGE — add background?, schedule? params (Q5, Q2)
├── tools/
│   └── fleet-results.ts           # NEW — fleet.results({ runId? }) tool (Q6=C)
├── panel/
│   └── fleet-panel.ts             # CHANGE — new `scheduled` tab; bg status icons on fleet rows (Q8)
└── index.ts                       # CHANGE — wire async runtime + scheduler + resume-on-init
```

**No changes** to: `src/lifecycle/run-lifecycle.ts` (the phase loop), `src/backend/*`, `src/engine/spawnSubagent.ts`'s foreground path, `src/registry/*`, `src/todo-sync/*`, `src/memory-hydrate/*`.

---

## 5. Process & state model (Q1=B, Q7=A)

### 5.1 Session-bound process, durable state

An async/bg run is a child session **within the current pi process**. If pi exits (crash, quit, machine restart), the run process dies — there is no daemon. **Run state survives** on disk so the run can be resumed.

State lives in two places:

| Artifact | Path | Format | Write model |
|---|---|---|---|
| Run journal | `.pi/fleet/runs/<runId>.jsonl` | JSONL — one event per line | append-only |
| Schedules | `.pi/fleet/schedules.json` | JSON array | atomic rewrite (temp + rename) |
| Schedule PID-lock | `.pi/fleet/schedules.lock` | single line: `<pid>` | atomic rewrite |
| Worktrees | `.pi/fleet/worktrees/<runId>/` | git worktree | git-managed |

### 5.2 The run journal — event shape

Each event is one JSONL line. Event types:

```
{"type":"run:started","runId":"fl-...","task":"...","lifecycle":"default","worktree":{"path":"...","branch":"fleet/fl-..."},"mode":"auto","ts":"..."}
{"type":"phase:started","phase":"brainstorm","ts":"..."}
{"type":"phase:completed","phase":"brainstorm","summary":"...","paths":["docs/design.md"],"ts":"..."}
{"type":"checkpoint","phase":"implement","decision":"continue","ts":"..."}
{"type":"phase:failed","phase":"brainstorm","error":"missing Artifacts block","ts":"..."}
{"type":"run:completed","runId":"fl-...","branch":"fleet/fl-...","ts":"..."}
{"type":"run:aborted","runId":"fl-...","reason":"user-abort","ts":"..."}
```

A run is **terminal** when its journal ends with `run:completed` or `run:aborted`. A non-terminal journal on pi start = interrupted run → resume candidate.

### 5.3 Resume

On extension init, `resume.scanRuns(projectDir)` reads `.pi/fleet/runs/*.jsonl`, replays each to its last valid event, and for any non-terminal run:
- If the run's worktree still exists → offer to resume (re-spawn from the first non-completed phase, re-entering the recorded worktree cwd).
- If the worktree is gone → mark the journal `run:aborted { reason: "worktree-missing" }` + notify.

**Partial-line skip:** if the journal's last line is incomplete (crash mid-append), the parser discards it and resumes from the last valid event. This is the crash-safety property of append-only JSONL (Q7=A).

### 5.4 The `i:Info` timeline reads the journal

SPEC-4's `i:Info` view reads the phase timeline from the TODO-notes progress block. SPEC-5a extends it to also read the journal (the journal is the richer source — it has timestamps + paths + checkpoint decisions). For bg runs, the journal is the source of truth; for foreground runs (no journal), the TODO-notes block remains the source.

---

## 6. Worktree isolation (Q2=A)

### 6.1 Scope — async/bg only, foreground unchanged

| Run kind | Worktree? | Cwd | Artifact discovery |
|---|---|---|---|
| Foreground sync `subagent` (SPEC-1..4) | no | parent cwd (unchanged) | `Artifacts:` parser (unchanged) |
| Async/bg single delegate | yes | `.pi/fleet/worktrees/<runId>/` | worktree-diff |
| Async/bg lifecycle | yes (one per lifecycle) | `.pi/fleet/worktrees/<runId>/` | worktree-diff per phase |
| Scheduled run | yes (it's async/bg) | `.pi/fleet/worktrees/<runId>/` | worktree-diff |

**Zero breaking change** to foreground sync — the v0.1..0.4 behavior is untouched.

### 6.2 Worktree lifecycle

`WorktreeService` (greenfield, `src/worktree/worktree-service.ts`):

```
create(runId, baseRef = "HEAD"):
  branch = `fleet/${runId}`
  path   = `.pi/fleet/worktrees/${runId}`
  git worktree add -b ${branch} ${path} ${baseRef}
  return { path, branch }

remove(runId):
  git worktree remove --force ${path}
  git branch -D ${branch}   # only on abort/cleanup; on completion the branch is kept for merge

diffPhase(runId):                # → DiffService
  git -C ${path} diff ${baseRef} -- .          # tracked modifications
  + git -C ${path} status --porcelain          # untracked new files
  → { paths: string[], summary: string }
```

- **On completion:** the worktree is committed to `fleet/<runId>`. For a **lifecycle**, the finish phase commits (the finish skill's merge/PR policy applies). For a **single delegate** (no lifecycle), the async runner commits on run completion (all changes in the worktree). The branch is **kept** in both cases (for merge/inspection).
- **On abort:** `WorktreeService.remove(runId)` — worktree removed, branch deleted. (Spec note: a `--keep-on-abort` inspection flag is a future refinement; default is clean removal.)
- **On resume:** the worktree is re-entered, not recreated (it already exists from the interrupted run).

### 6.3 Branch naming + base ref

- Branch: `fleet/<runId>` (e.g. `fleet/fl-mrz3ezrd-2gq24n`). Namespaced to avoid collisions with user branches.
- Base ref: `HEAD` at run start (the current workspace HEAD). Recorded in the journal's `run:started` event so resume + diff use the same base.

### 6.4 This fixes the smoke temp-cwd bug

The SPEC-4 smoke script's `smokeCwd` fix (`252770d`) was ineffective because the child session's tool execution runs in the parent process's `process.cwd()`, not the passed `cwd`. For async/bg runs, SPEC-5a's worktree IS the isolation — the child runs in a real worktree with its own cwd, so tool I/O lands there by construction. (The foreground smoke script remains a smoke-script concern — run it from a throwaway cwd, per the handoff note.)

---

## 7. Artifact discovery (Q3=A)

### 7.1 Isolated runs — DiffService

For async/bg runs, `DiffService.diffPhase(runId)` computes the phase's artifacts as **all changes in the worktree vs the base ref**:

- Tracked modifications: `git -C <wt> diff <baseRef> --name-only`
- Untracked new files: `git -C <wt> status --porcelain` (filter `??` entries)

Both are included — a phase that creates a brand-new `design.md` shows as untracked and is a valid artifact. The prose summary is the child's final text (truncated to a reasonable length).

**This replaces the prompt-baked `Artifacts:` YAML block for isolated runs.** The block was fragile — today's TUI smoke proved a smaller model (`glm-5.2:cloud`) can complete the work without emitting a well-formed block, causing a false phase failure. The diff is structural; it doesn't depend on the model's output format.

### 7.2 Foreground runs — unchanged

Foreground sync runs have no worktree to diff, so they keep SPEC-4's `parseArtifacts` (the `Artifacts:` YAML parser, including the fenced-block + prompt-echo-trailer robustness from `df108e5`). No regression.

### 7.3 The phase record

The phase record (`{ name, status, summary, paths, reviseCount }`) is populated:
- Isolated: `paths` from `DiffService.diffPhase`, `summary` from child final text.
- Foreground: `paths` + `summary` from `parseArtifacts` (unchanged).

The lifecycle loop's downstream behavior (checkpoint, Revise, next-phase `prev` injection) is unchanged — it consumes the phase record, not the discovery mechanism.

---

## 8. Concurrency (Q4=A)

### 8.1 Two pools

| Pool | Type | Default | Config | Scope |
|---|---|---|---|---|
| Foreground sync | `createSingleSlotLock` (SPEC-1, unchanged) | 1 | (not configurable) | one at a time, caller awaits |
| Async/bg | `ConcurrencyPool` (new, `src/runtime/concurrency-pool.ts`) | 3 | `fleet.maxConcurrentBg` in settings.json | up to N parallel bg runs |

Foreground and bg pools are **independent** — a foreground call never waits on a bg slot, and bg runs never compete with the foreground single-slot. Max concurrent children = 1 fg + N bg (default 1+3=4).

### 8.2 Intra-lifecycle serialization

Phases within a single lifecycle are **sequential** (the lifecycle loop awaits each phase — unchanged from SPEC-4). The N-slot pool governs **inter-lifecycle** parallelism: up to N async/bg lifecycles (or single delegates) in parallel.

### 8.3 Pool exhaustion

When N bg slots are full, a new bg request queues (the pool returns a promise that resolves when a slot frees). The `/fleet` fleet tab shows queued runs with a `⏳` indicator. There is no unbounded fan-out (Q4=A rejected unlimited — rate-limit + cost safety).

### 8.4 SPEC-6 extension point

The `ConcurrencyPool` is the natural place to layer SPEC-6's cost-aware concurrency: tier-based caps (cheaper models → higher N), per-agent budgets, per-phase limits. The two-pool separation keeps that a clean extension.

---

## 9. Scheduling (Q5=A)

### 9.1 Expression types

| Type | Syntax | Example | Next-fire computed by |
|---|---|---|---|
| cron | 5-field cron string | `0 9 * * 1-5` (weekdays 9am) | vendored `cron-parser` |
| interval | `<number><unit>` (`s`/`m`/`h`/`d`) | `30m` | `Date.now() + ms` |
| one-shot | ISO 8601 datetime | `2026-07-25T14:00` | the datetime itself (fires once) |

`expressions.parse(expr) → { type, nextFire(prevFire): Date }`.

### 9.2 Registration surfaces (interactive-first)

Per the getpipher interactive-first principle (`~/local-dev/getpipher/AGENTS.md`), the panel is the primary human surface; the tool action is the agent's path; the slash is a thin mirror.

| Surface | Audience | Form |
|---|---|---|
| `/fleet` → `scheduled` tab | human (primary) | list with next-fire; add (inline Input: task → expr → lifecycle); pause/resume; delete |
| `subagent({ task, schedule, lifecycle?, auto? })` | agent | programmatic; registers a schedule that fires an async/bg run |
| `/fleet-schedule <task> <expr> [--lifecycle <name>] [--auto]` | human (thin mirror) | convenience slash; prints the registered schedule + next-fire |

### 9.3 Firing — in-process, PID-locked

- **Timer:** the scheduler holds an in-process timer per schedule (setInterval for interval/cron-next-fire, setTimeout for one-shot). Schedules fire **only while pi is open** (session-scoped, Q1=B).
- **PID-lock:** `.pi/fleet/schedules.lock` records the owning pi PID. On extension init, the scheduler writes the current PID if the lock is free or held by a dead PID. A second pi session on the same project sees the schedules (reads `schedules.json`) but does **not** fire them — it defers to the owning PID. This prevents double-fire when two pi sessions are open on the same project.
- **No catch-up:** if pi was closed when a cron fire was due, the missed fire is **not** run on next open. The next fire is the next matching time after pi is open. This is the honest consequence of session-scoped (no daemon, Q1=B) — surfaced clearly in the `/fleet` scheduled tab (each row shows "next fire: …").

### 9.4 What a scheduled run does

A scheduled run is an async/bg run (worktree + journal + inbox). On fire, the scheduler calls the async runtime with the schedule's `{ task, lifecycle, auto }` — identical path to `background=true`. The resulting run appears in the `/fleet` fleet tab like any bg run.

---

## 10. Auto-delivery (Q6=C)

### 10.1 On completion

When an async/bg run completes:
1. `pi.notify("fleet run <runId> completed")` — a pi notification.
2. The `/fleet` fleet tab row → `✓` (or `✗` on failure).
3. The lifecycle TODO → `done` (armory-todo); the result summary is in the TODO notes (the **durable** record).
4. The result summary is queued in the in-memory **results inbox** (`src/runtime/results-inbox.ts`).

### 10.2 The agent pulls results

- `fleet.results({ runId? })` tool action: with a `runId` returns that run's summary; without, returns all ready summaries. Pulling marks them delivered (cleared from the inbox).
- A **bounded** system-prompt hint `N fleet results ready` (cap at 5; collapse to one line; clears once pulled) nudges the agent to pull. This is injected into the parent agent's context so it knows bg work has landed — without intruding on the live turn (Q6=C rejected B's mid-turn inject).

### 10.3 Durability

The inbox is **in-memory** (lost on pi restart). The durable record is the lifecycle TODO notes + the journal + the `/fleet` row. So a run that completes while pi is closed is found on next open via `/todo finished` + the `/fleet` fleet tab (recent rows) — the inbox is just the fast in-session pointer for the agent.

---

## 11. The `/fleet` panel — `scheduled` tab + bg row status (Q8=A)

### 11.1 Tabs after SPEC-5a

```
fleet · lifecycle · agents · backends · scheduled
```

One new tab (`scheduled`); the existing `fleet` tab gains bg status icons. The `lifecycle`/`agents`/`backends` tabs are unchanged.

### 11.2 `fleet` tab — bg row status

Bg run rows show live status + phase progress (foreground rows unchanged from SPEC-4):

| Status | Icon | Example row |
|---|---|---|
| running | `▶` | `▶ fl-...  default  ●implement 3/5  checkpointed  2m  pi  "..."` |
| queued (pool full) | `⏳` | `⏳ fl-...  default  queued  0/5  pi  "..."` |
| paused at checkpoint | `⏸` | `⏸ fl-...  default  ●review 4/5  checkpoint  3m  pi  "..."` |
| completed | `✓` | `✓ fl-...  default  done  5/5  34s  pi  fleet/<branch>  "..."` |
| failed | `✗` | `✗ fl-...  default  failed  brainstorm 1/5  12s  pi  "..."` |

The phase-progress marker `●<phase> <n>/<total>` updates from the journal events as the run advances.

### 11.3 `scheduled` tab — the list view

```
SCHEDULED
  ▶  30m        default   "monitor deps"            next: 2026-07-24 16:00   fl-...
  ▶  0 9 * * 1-5  default   "morning audit"          next: 2026-07-25 09:00   fl-...
  ⏸  2h         default   "refresh cache"           paused                    fl-...
  ◉  once       default   "one-shot deploy"         next: 2026-07-25 14:00   fl-...

  a:Add  p:Pause/resume  d:Delete  i:Info  tab:Fleet  q:Quit
```

- `a:Add` → inline Input: task → expr → lifecycle (blank=default) → registers, shows next-fire.
- `p:Pause/resume` on the selected row.
- `d:Delete` removes the schedule (a running fire is not killed; the schedule just stops re-firing).
- `i:Info` shows the schedule's last-fire + next-fire + the runIds it has spawned.

### 11.4 No live widget / conversation viewer

The live widget, conversation viewer, and mid-run steering are **SPEC-5b**. SPEC-5a's TUI is minimal-but-complete for operational visibility: you can see a bg run's phase progress in the fleet tab + manage schedules in the scheduled tab.

### 11.5 EditorTheme gotcha (carried from AGENTS.md)

The `scheduled` tab is a `ctx.ui.custom` panel (like the existing tabs), so it receives the full `Theme` — no EditorTheme risk. The inline `Input` for schedule add is single-line (pi-tui can't nest `ctx.ui.editor()` inside `ctx.ui.custom()`), same pattern as SPEC-4's `task>` Input.

---

## 12. The `subagent` tool — `background` + `schedule` params

### 12.1 New params

```
subagent({
  agent, task, model?, lifecycle?, auto?,          // SPEC-4 (unchanged)
  background?: boolean,                             // NEW — fire without awaiting (Q1, Q2)
  schedule?: string,                                // NEW — "30m" | "0 9 * * 1-5" | ISO datetime (Q5)
})
```

- `background: true` → async runner path (worktree + journal + inbox). The tool returns immediately with `{ runId, status: "background" }`.
- `schedule: "..."` → scheduling path (registers a schedule; the run fires on the schedule). The tool returns `{ scheduleId, nextFire }`.
- `background` + `schedule` is invalid → actionable error ("a scheduled run is inherently background; pass only one").
- Neither → foreground sync (SPEC-1..4, unchanged).

### 12.2 `fleet.results` tool (new)

```
fleet.results({ runId? })
  → { results: Array<{ runId, task, status, summary, paths, branch?, completedAt }> }
```

No `runId` = all ready (undelivered) results, marked delivered on read. With `runId` = that run's result (does not mark delivered unless it was ready).

---

## 13. Guards (SPEC-1/2/3/4 §9/§11 carried forward)

- **Foreground single-slot lock** — unchanged (Q4=A).
- **Todo-excluded + Esc-abort** — carry to bg runs (Esc in the panel aborts the selected bg run → `run:aborted`).
- **Worktree cleanup on abort/failure** — `WorktreeService.remove` is called in a `finally` for failed/aborted runs (completed runs keep the branch).
- **Journal integrity** — append-only + partial-line skip (Q7=A).
- **PID-lock** — only the owning pi PID fires schedules; a stale PID is reclaimed (Q5=A).
- **No unbounded fan-out** — the N-slot pool caps concurrent bg runs (Q4=A).
- **Resolve-time validation** — a bad cron expression errors at registration, not at fire time; a dirty working tree (uncommitted changes that would conflict with `git worktree add`) errors at run start with an actionable message.

---

## 14. Error handling + failure modes

| Failure | Behavior |
|---|---|
| Worktree creation fails (dirty tree, branch exists, disk full) | run marked `failed`, journal `run:aborted { reason: "worktree-create-failed", error }`, no orphan worktree, notify |
| Cron expression invalid | resolve-time error at registration (tool returns actionable error; panel shows inline error) |
| Journal last line incomplete (crash mid-append) | discard the partial line, resume from last valid event |
| Schedule PID-lock held by a live second pi | second session reads schedules but does not fire; logs "schedules owned by PID <n>" |
| Schedule PID-lock held by a dead PID | reclaim: write current PID, resume firing |
| Resume: worktree missing | mark journal `run:aborted { reason: "worktree-missing" }`, notify, do not attempt resume |
| Resume: worktree present | offer resume (re-spawn from first non-completed phase) |
| Bg run completes while pi closed | on next open: `/fleet` fleet tab shows the ✓ row (recent); `/todo finished` shows the done TODO; the inbox was in-memory so no auto-nudge, but the durable record is intact |
| Pool exhausted | new bg request queues (`⏳` in fleet tab); no rejection |
| `fleet.results()` with no ready results | returns `{ results: [] }` |

---

## 15. Testing (mirrors SPEC-1..4: `node --import tsx --test`, no real LLM in unit tests)

- **`WorktreeService` / `DiffService`**: real-git temp-repo tests (`mkdtempSync` + `git init` + commit a base file → `create()` → write a new file + modify one → `diffPhase()` asserts both paths → `remove()`). No LLM.
- **`run-journal`**: append events → replay reconstructs state → write a partial last line → replay skips it → resume detection identifies non-terminal journals.
- **`concurrency-pool`**: N slots → N+1th acquire blocks → release one → the blocked acquire resolves → exhaustion + release.
- **`expressions` / cron**: vendored `cron-parser` tested via its own frozen suite; our wrapper tests next-fire wiring for cron (`0 9 * * 1-5`), interval (`30m`), one-shot (ISO).
- **`scheduler` / `pid-lock`**: register/pause/resume/delete; PID-lock contention (two mock PIDs, only owner fires); no-catch-up (a missed fire is not re-run).
- **`results-inbox`**: push results → `fleet.results()` returns them → marks delivered → bounded hint collapses N.
- **`async-runner` integration**: fake `runLifecycle` (no real LLM) → async runner creates a worktree, drives the fake lifecycle, journals events, diff discovers artifacts, completion → inbox + notify. Asserts the journal + worktree + inbox end-to-end.
- **End-to-end smoke (manual, not CI):** a scheduled one-shot fires a trivial isolated lifecycle on `Ollama/glm-5.2:cloud` in a temp git repo → worktree created → phases run → diff discovers artifacts → journal records → completion notify + inbox + `fleet.results()`. (Safe cwd — the worktree IS the isolation; no repo pollution.)

---

## 16. Deferred (recorded, with landing SPEC)

| Item | Landing SPEC |
|---|---|
| FleetView navigable list, live widget, conversation viewer, mid-run steering | SPEC-5b |
| `--keep-on-abort` worktree inspection flag | SPEC-5b (fleet TUI surfaces it) or SPEC-6 |
| Cost-aware concurrency (tier-based caps, per-agent budgets) | SPEC-6 |
| Quality gates (verify / judgePanel / loopUntilDry) as lifecycle hooks | SPEC-6 |
| Workflows-as-code (JS orchestration + journaled edit-and-resume) — builds on the JSONL journal from Q7=A | SPEC-6 |
| Event-bus + cross-extension RPC (other extensions spawn/steer/observe) | SPEC-6 |
| Cross-reboot daemon (runs surviving pi exit) | rejected (Q1=B); reconsider only if a real overnight-across-reboots need emerges |
| Catch-up for missed scheduled fires while pi closed | rejected (Q1=B session-scoped); a "run on next open if missed" policy is a future opt-in |

---

## 17. Done bar (v0.5a, from PRD §8)

- **Background parallel agents on isolated worktrees** — `subagent({ task, background: true, lifecycle })` fires without awaiting; parallel edits never conflict (separate worktrees).
- **Schedule recurring subagents** — `subagent({ task, schedule: "0 9 * * 1-5" })` or the `/fleet` scheduled tab registers a recurring/one-shot run.
- **Auto-resume after crash** — a killed pi mid-lifecycle is detected on next project open; fleet offers to resume from the last checkpoint.
- **Auto-delivery** — completed bg runs notify + queue in the inbox; the parent agent pulls via `fleet.results()`.
- **`/fleet` Scheduled tab** — manage schedules interactively (add/pause/resume/delete + next-fire).
- **Vendored plumbing** — `cron-parser` (MIT, frozen, attributed) + greenfield worktree service.

**Release:** `@getpipher/armory-fleet@0.5.0` via `release.yml` on `v0.5.0` tag (mirrors v0.3.0/v0.4.0).