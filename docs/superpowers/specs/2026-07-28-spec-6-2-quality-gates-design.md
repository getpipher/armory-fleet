# SPEC-6-2 — Quality gates + lifecycle hooks

**Date:** 2026-07-28
**Sub-SPEC of:** SPEC-6 (Power-user tier → v1.0)
**Package:** `@getpipher/armory-fleet` · target release `0.11.0` (minor)
**Predecessors:** SPEC-6-1 (v0.10.0/v0.10.1/v0.10.2 — cost-aware tiers + cost $ + context% + Tiers view); v0.10.2 patch (reconcile syncs in-memory RunRegistry — surfaced the liveness-probe gap this SPEC closes)
**Pipeline step:** brainstorm (this doc) → plan → implementation

## 1. Context

SPEC-6-2 is the second sub-SPEC of SPEC-6 (Power-user tier → v1.0). The roadmap split (per the SPEC-6-1 brainstorm):

| Sub-SPEC | Surfaces | Release |
|---|---|---|
| 6-1 (DONE) | A+B+C+D — cost-aware tier routing + $ accounting + context% + Tiers view | v0.10.x |
| **6-2 (this)** | **E+F — quality patterns (gates) + lifecycle hooks** | **v0.11.0** |
| 6-3 | G — workflows-as-code | v0.12.0 |
| 6-4 | H+I — event-bus RPC + live conversation viewer → v1.0.0 | v0.13.0 → v1.0.0 |

SPEC-6-1 is the **foundation** — 6-2's `gate` predicate asserts against the cost numbers + tier-resolved model from 6-1 (`RunRecord.costTotal`, `contextTokens`, `tier`, `TierRegistry`/`resolveAgentModel` all ship in v0.10.2). 6-2 reads from them; it does not re-own them.

### What 6-2 closes

- **Quality patterns (PRD §8: "verify / judgePanel / loopUntilDry / completenessCheck / gate / checkpoint"):** today the lifecycle has a phase loop + an `onCheckpoint` callback but **no gate concept** (`PhaseDef` has `name/skills/agent/backend/checkpoint/promptTemplate` only). Quality is entirely prompt-baked (skills in the bundle) + human-judged at the checkpoint. 6-2 adds a composable gate chain that runs after each phase's output, produces structured evidence, and feeds the checkpoint — with teeth (per-gate `onFail`: advise/revise/abort).
- **Lifecycle hooks (PRD §8: "verification-before-completion + challenge-step lifecycle hooks baked in"):** today `verification-before-completion` is a skill in the `implement` phase bundle only; `challenge-step` is an AGENTS.md directive with no lifecycle presence at all. 6-2 bakes both in: `verification-before-completion` becomes a predicate gate (enforced — runs as a gate, not just a prompt nudge); `challenge-step` becomes a lifecycle-wide prompt injection (soft — self-critique can't be structurally enforced).
- **The v0.10.2 liveness gap:** the reconcile fix surfaced that orphan detection is an age+grace *heuristic* — no real liveness probe on the `session` handle. A cross-cwd same-process orphan leaks into another session's widget. 6-2 adds a hybrid liveness probe (`isAlive()` on `LiveSessionHandle` for pi / `pid` + `process.kill(pid,0)` for claude / age+grace fallback for cross-process pi-backend) + a `cwd` tag on `RunRecord` that closes the cross-cwd leak. Retires the heuristic for the common case; keeps it as the honest fallback for the one unreachable case.

### What 6-2 defers (YAGNI)

- **`judgePanel` (multi-agent panel) + `loopUntilDry` (repeat-until-stable):** composite gates built *on top of* the gate seam. Deferred to a follow-up sub-SPEC (6-2.1 or folded into 6-3) — build once the seam is proven. The `GateRegistry` + `pi.registerGate` hook (this SPEC) are the extensibility path, so users can hand-roll them meanwhile.

## 2. Design decisions (settled in brainstorm)

| # | Decision | Choice |
|---|---|---|
| Q1 | Integration model | **A — composable phase-exit gates.** After phase output, run a configurable chain of gates → checkpoint sees their evidence. Gates first-class, visible in `/fleet`, assertable against v0.10.2 surfaces. |
| Q2 | Session-liveness hook scope | **b — standalone runtime hook.** Not a gate (liveness is a runtime problem, not phase-exit). Retires the reconcile age+grace heuristic with a real probe; closes the cross-cwd leak. |
| Q3 | Gate execution model | **iii — hybrid agent/predicate gates.** Agent gates (verify) spawn a subagent, cost tokens, appear in `/fleet`; predicate gates (completenessCheck, gate, verification-before-completion) run in-process, free, assert against v0.10.2 fields. Both share one `GateResult` shape. |
| Q4 | Gate failure semantics | **C — per-gate `onFail` (advise/revise/abort).** Each gate declares its failure action. `completenessCheck`→revise, `verify`→advise, `gate`→abort. In `auto` mode the `onFail` actions execute directly (quality teeth for auto runs). |
| Q5 | Builtin gate set | **B — 3 core builtins now, defer 2 composites.** Ship `verify`, `completenessCheck`, `gate` (the common case); defer `judgePanel` + `loopUntilDry` (composite, build once the seam is proven). |
| Q6 | Hook enforcement model | **B — verification-before-completion as a predicate gate (4th builtin), challenge-step soft.** v-b-c has a clean structural signal (output contains verification evidence) → predicate gate with `onFail:revise`. challenge-step is self-critique (no honest structural signal) → soft skill injection, lifecycle-wide via `renderPhasePrompt`. |
| Q7 | Liveness probe mechanics | **C — hybrid: real probe for handle-bearing runs, age+grace fallback for log-only.** `isAlive()` on `LiveSessionHandle` (pi) + `pid`/`process.kill(pid,0)` (claude) for in-process + cross-process-claude; age+grace from the per-cwd log for the one unreachable case (cross-process pi-backend). Ships `cwd`/`backend`/`pid` on `RunRecord` + `pid`/`cwd` in `run:meta`. |

### Final 6-2 surface

| Surface | Members | Mechanism |
|---|---|---|
| **Gates (4 builtins)** | `verify` (agent, advise), `completenessCheck` (predicate, revise), `gate` (predicate, abort), `verification-before-completion` (predicate, revise) | gate chain in `run-lifecycle.ts`, after parse-artifacts, before checkpoint |
| **Hooks (2)** | `challenge-step` (soft skill injection), `session-liveness` (runtime probe) | challenge-step = `renderPhasePrompt` lifecycle-wide injection + `PhaseDef.challengeStep` opt-out; liveness = `probeRun` in `reconcile.ts` |
| **Runtime fixes** | cross-cwd leak (`RunRecord.cwd` + widget filter); `emitProgress` backend hardcode (now reads `RunRecord.backend`) | adjacent fixes folded in (we touch the fields anyway) |

## 3. Architecture

Two seams, both slotting into existing surfaces (no new top-level module):

| Seam | Where it slots | What it adds |
|---|---|---|
| **Gate chain** | `run-lifecycle.ts` phase loop — between *parse-artifacts* and *checkpoint* | a configurable chain of quality gates per phase; runs left-to-right; produces `GateResult[]` that flows to the checkpoint decision |
| **Liveness hook** | `reconcile.ts` (replaces the age+grace body) + `RunRecord`/`LiveSessionHandle` (carry probe data) | a real probe for in-process orphans; age+grace kept as the cross-process-pi-backend fallback only |

### Phase loop, before and after

| Step | Today (v0.10.2) | SPEC-6-2 |
|---|---|---|
| 1 | spawn phase → `SpawnResult` | same |
| 2 | parse artifacts → `PhaseRecord` | same |
| **2.5** | — | **run gate chain → `GateResult[]`** (new) |
| 3 | `updateProgress` | same (+ gate evidence in the progress line) |
| 4 | `onCheckpoint(phaseRec)` → continue/revise/abort | `onCheckpoint(phaseRec, gateResults)` → continue/revise/abort (signature widens) |

Two new registries/hooks, mirroring the existing agent/lifecycle registry pattern:

| Registry | Holds | Populated by |
|---|---|---|
| **GateRegistry** | the 4 builtin gates + user-registered gates | `src/lifecycle/gates/` (builtin) + `pi.registerGate` extension hook |
| (no new registry for hooks) | challenge-step is a prompt-renderer injection; session-liveness is a single `probeRun` fn in `reconcile.ts` | — |

### Files touched

| File | Change |
|---|---|
| `src/lifecycle/lifecycle-types.ts` | `PhaseDef.gates?: GateRef[]`; `PhaseDef.challengeStep?: boolean`; `GateDef`, `GateResult`, `GateRef`, `GateKind`, `GateCtx` types; `CheckpointFn` widens to `(phase, gateResults)` |
| `src/lifecycle/gates/` (new dir) | `registry.ts` (GateRegistry) + `verify.ts`, `completeness-check.ts`, `gate.ts`, `verification-before-completion.ts`, `chain-runner.ts` (the 4 builtins + the chain runner) |
| `src/lifecycle/run-lifecycle.ts` | gate-chain runner invocation between parse-artifacts and checkpoint; short-circuit on `revise`/`abort`; thread `GateResult[]` to `onCheckpoint` |
| `src/lifecycle/prompt-template.ts` | `challenge-step` block auto-appended to every phase prompt unless `challengeStep: false` |
| `src/lifecycle/default.ts` | add `gates:` to each phase of the default lifecycle (§6); `challengeStep: false` on `finish` |
| `src/engine/run-registry.ts` | `RunRecord` gains `cwd: string`, `backend: BackendId`, `pid?: number` |
| `src/engine/spawnSubagent.ts` | store `cwd`/`backend`/`pid` on the record; `LiveSessionHandle.isAlive()`; both backend impls |
| `src/runtime/run-log.ts` | `run:meta` gains `pid?: number` + `cwd: string` (cross-process durability) |
| `src/runtime/reconcile.ts` | `probeRun(rec, now, grace)` — real probe first, age+grace fallback; abort orphans in both log + registry; periodic timer entry point |
| `src/panel/fleet-items.ts` (or lifecycle-items.ts) | gate-line rendering (pure fn, unit-tested) — glyphs per `onFail`, evidence excerpt |
| `src/panel/fleet-panel.ts` | wire gate results into the Lifecycle view row; View-evidence / Re-run-gate actions |
| `src/panel/fleet-widget.ts` | filter `runRegistry.list()` by `cwd === thisCwd` (cross-cwd leak fix) |

## 4. Gate chain execution

### Chain runner algorithm

The gate chain runs *inside* the existing per-phase revise loop, after parse-artifacts — so a gate-triggered revise reuses the same loop, the same `MAX_REVISE` budget, the same feedback-to-phase mechanism. It's an earlier decision point in the same iteration, not a parallel system.

```
# inside the revise loop, after parse-artifacts → phaseRec:
gateResults: GateResult[] = []
shortCircuit = null
for gate in resolveGates(phaseDef.gates, gateRegistry):
  ctx = { phaseRec, spawnRes, lifecycle, tier, lifecycleCost, contextTokens, todoId, worktreePath, spawn, getModelContextWindow }
  result = await runGate(gate, ctx)        # agent → spawn; predicate → in-process fn
  gateResults.push(result)
  if !result.passed:
    match gate.onFail:
      "advise"  → continue chain           # collect evidence, checkpoint will see it
      "revise"  → shortCircuit = {action:"revise", feedback: result.evidence}; break
      "abort"   → shortCircuit = {action:"abort",   reason: result.evidence}; break
  # passed → continue

if shortCircuit?.action == "revise":
  reviseCount++; lastFeedback = shortCircuit.feedback; continue revise loop  # re-run PHASE
if shortCircuit?.action == "abort":
  return doneResult(... "aborted/failed", error: shortCircuit.reason)
# no short-circuit (all passed or only advise-failures) → checkpoint fires
decision = await onCheckpoint(phaseRec, gateResults)
```

| `onFail` | Chain behavior | Revise budget | Checkpoint fires? |
|---|---|---|---|
| `advise` | continues; evidence collected | unchanged | yes — sees the failure evidence |
| `revise` | short-circuits; feeds gate evidence as the revise feedback | consumes one `MAX_REVISE` | no — phase re-runs first |
| `abort` | short-circuits; lifecycle aborts/fails with the gate reason | n/a | no — lifecycle ends |

A `verification-before-completion` failure → revise (re-run the phase, "your output had no verification evidence"). A `gate` cost-cap breach → abort (the budget's spent). A `verify` that found issues → advise (the human checkpoint weighs the review). All three share the seam.

### The 4 builtin gates

| Gate | Kind | `onFail` | Input (from chain ctx) | Execution | Output `GateResult` |
|---|---|---|---|---|---|
| `verification-before-completion` | predicate | `revise` | `spawnRes.finalText` | regex/heuristic scan for verification evidence: a command invocation (`pnpm test:run`, `typecheck`, `lint`, `build`) + its exit/output (`0 failures`, `exit 0`, `N pass`). Absent → fail. Patterns tunable via `params.patterns`. | `{ passed, evidence: "found: pnpm test:run → 368 pass" }` or `{ passed:false, evidence: "no verification command output found" }` |
| `completenessCheck` | predicate | `revise` | `phaseRec.paths`, `worktreePath?` | `stat()` every claimed path. Missing file → fail. On worktree runs, stats against `worktreePath`. | `{ passed, evidence: "5/5 artifacts exist" }` or `{ passed:false, evidence: "missing: src/foo.ts" }` |
| `gate` | predicate | `abort` | `lifecycleCost`, `tier`, `contextTokens` | asserts `params`-configured bounds. Defaults: `lifecycleCost < tier.costCap`, `contextTokens < tier.contextFloor`. Breach → fail. Missing tier → skip (advise-pass). | `{ passed, evidence: "cost $0.42 < cap $1.00; ctx 27K < floor 200K" }` or `{ passed:false, evidence: "cost $1.12 > cap $1.00" }` |
| `verify` | agent | `advise` | `task`, `phaseRec.summary`, `phaseRec.paths`, `prev` phase | spawns an independent reviewer subagent (own `RunRecord`/runId, agent pinned via `params.agent ?? "reviewer"`), linked to the lifecycle `todoId`. Prompt: "Review this phase's output against the task + plan. Did it meet the requirement? What's missing?" Reads `finalText`. | `{ passed, evidence: <review>, cost, runId }` — `passed` = finalText lacks failure markers ("does not meet", "missing", "incomplete") |

The `verify` `passed` heuristic is intentionally fuzzy because `onFail: "advise"` — a wrong `passed` just means the human checkpoint sees the review (which is the point). The evidence (full review text) is what matters, not the boolean.

### Cost accounting

| Cost source | Where it accrues |
|---|---|
| Phase spawn (the phase agent) | the phase run's `RunRecord.costTotal` (existing) |
| `verify` gate spawn (reviewer) | its **own** `RunRecord` (own runId, own `/fleet` row), linked to the lifecycle `todoId` |
| `lifecycleCost` (the `gate` assertion input) | **sum of `costTotal` across all runs linked to this lifecycle's `todoId`** — computed by the chain runner from the `RunRegistry` |

So the `gate` predicate asserts against the *lifecycle's* cumulative spend (phases + gate-spawned reviewers) — the honest unit for a cost cap. The `verify` reviewer shows as its own row in `/fleet`; its cost rolls up into the lifecycle total the `gate` checks. Predicate gates cost nothing and create no runs.

### Edge cases

| Case | Behavior |
|---|---|
| Gate spawn fails (reviewer crashes) | `verify` returns `GateResult { passed:false, evidence:"reviewer spawn failed: <err>" }` with `onFail:"advise"` — checkpoint sees the failure; doesn't auto-revise on a crash (can't fix a crash by re-running the phase) |
| `revise` gate exhausts `MAX_REVISE` | same as today's checkpoint-revise exhaustion → lifecycle `failed` with "gate '<name>' revise budget exhausted" |
| Phase has no `gates:` declared | chain is empty → `gateResults = []` → checkpoint fires as today (zero behavioral change for lifecycles that don't opt in) |
| `auto` mode (no human checkpoint) | gate `onFail` actions execute directly; `advise` failures with no checkpoint → logged in progress, lifecycle continues (advise is advisory) |
| `gate` asserts before any `verify` spawn | left-to-right order means a cost abort fires *before* spending tokens on a reviewer — the short-circuit saves the money |

## 5. Hook surfaces

### Hook 1 — `challenge-step` (soft skill injection)

`renderPhasePrompt` auto-appends a challenge-step block to every phase prompt by default; `PhaseDef.challengeStep?: boolean` (default `true`) opts out. This bakes it into ALL lifecycles (default + custom), not just the shipped one — matching the PRD's "baked in" intent. The injected block is the AGENTS.md Challenge Step verbatim:

> After completing significant work, actively challenge your own output before presenting it. Ask: "What could break? What did I miss? What would a critical reviewer flag?" Fix what you find — don't just note it. Small single-line changes are exempt.

This fires *inside* the phase agent (before it emits its `Artifacts:` block) — a self-critique nudge, not a runtime check. There's no honest structural signal for "did the agent challenge its work," so we inject and trust, same as any skill.

### Hook 2 — `session-liveness` (hybrid probe)

Once `pid` is stored on `RunRecord` + `run:meta`, the fallback narrows — `process.kill(pid, 0)` is system-wide, so a claude-backend run is probeable from *any* process on the machine. The age+grace fallback is only needed for one case: a cross-process **pi-backend** orphan (no pid — in-process session — and the handle lives in another process, unreachable from here).

| Run location | Backend | Probe | Mechanism |
|---|---|---|---|
| This process | pi | real | `rec.session?.isAlive()` — `LiveSessionHandle` gains `isAlive(): boolean` |
| This process | claude | real | `process.kill(rec.pid, 0)` — signal-0 liveness check |
| Other process, same cwd | claude | real | `process.kill(pid, 0)` — pid from `run:meta` in the shared per-cwd log; system-wide |
| Other process, same cwd | pi | **fallback** | age+grace: `now - startedAt > grace` from the log (the only case that keeps the heuristic) |
| Other process, other cwd | any | n/a | out of scope — reconcile scans per-cwd logs only; `cwd` tag filters the widget |

`LiveSessionHandle.isAlive()` per backend:

| Backend | `isAlive()` implementation |
|---|---|
| pi | forwards the SDK `ChildSession` active state (not disposed / not ended) |
| claude | `proc.killed === false && proc.exitCode === null && proc.signalCode === null` |

`probeRun(rec, now, grace)`:

```
# 1. real probe — in-process handle
if rec.session && typeof rec.session.isAlive == "function":
  return rec.session.isAlive() ? ALIVE : DEAD
# 2. real probe — pid (this process OR cross-process via log)
if rec.pid:
  try: process.kill(rec.pid, 0); return ALIVE
  catch: return DEAD
# 3. fallback — cross-process pi-backend orphan, no probe reachable
return (now - rec.startedAt > grace) ? DEAD : ALIVE
```

`reconcileRuns` becomes: for each `meta.status === "running"` in the per-cwd log → `probeRun` → if `DEAD`, abort in both log + in-memory registry (the v0.10.2 sync, now probe-driven).

**When the probe fires:**

| Trigger | Today | SPEC-6-2 |
|---|---|---|
| `session_start` (pi boot) | `reconcileRuns` (age+grace) | `reconcileRuns` (probeRun — real first, fallback) |
| Widget render | reads registry, no reconcile | optional: probe any `status:"running"` run whose handle/PID is cheap to check |
| Periodic timer (NEW) | none | low-frequency probe (e.g. every 60s) over same-cwd running runs — catches mid-session orphans without a restart |

All three call the same `probeRun` → abort path — one liveness decision function.

**Cross-cwd leak fix (ships with this hook):**

| Surface | Today | SPEC-6-2 |
|---|---|---|
| Live widget | `runRegistry.list()` — shows every same-process run regardless of cwd | filter `runRegistry.list().filter(r => r.cwd === thisCwd)` |
| Reconcile | scans per-cwd log (already same-cwd only) | same scan, probe-driven |
| RunRecord | no cwd/backend/pid | `cwd: string`, `backend: BackendId`, `pid?: number` set at spawn |

## 6. Data model + declaration

### Type additions (`src/lifecycle/lifecycle-types.ts` unless noted)

```ts
interface PhaseDef {
  // ...existing: name, skills, agent, backend, checkpoint, promptTemplate
  gates?: GateRef[];           // the phase-exit gate chain (Q1=A)
  challengeStep?: boolean;     // default true; false opts out of the lifecycle-wide injection
}

type GateRef = string | { name: string; onFail?: "advise"|"revise"|"abort"; params?: Record<string,unknown> };
//   "verify"                                → registry defaults
//   { name: "gate", params: { costCap: 2.0 } } → override params per-phase

interface GateDef {
  name: string;
  kind: "agent" | "predicate";           // Q3=iii
  onFail: "advise" | "revise" | "abort"; // Q4=C — registry default; phase can override
  params?: Record<string, unknown>;
  run: (ctx: GateCtx) => Promise<GateResult>;
}

interface GateCtx {
  phaseRec: PhaseRecord;
  spawnRes: SpawnResult;
  lifecycle: { name: string; task: string; todoId: string; backend: BackendId };
  tier?: Tier;
  lifecycleCost: number;     // sum of costTotal across all runs linked to todoId
  contextTokens: number;
  worktreePath?: string;
  spawn: SpawnFn;            // agent gates use this to spawn the reviewer
  getModelContextWindow: (model: string) => number | undefined;
}

interface GateResult {
  gate: string;
  kind: "agent" | "predicate";
  passed: boolean;
  evidence: string;
  onFail: "advise" | "revise" | "abort";   // resolved (registry default ∪ phase override)
  cost?: number;             // agent gates only
  runId?: string;            // agent gates only — links to the /fleet row
  durationMs?: number;
}

// Widened (backward-compatible — existing fns using only `phase` still typecheck):
type CheckpointFn = (phase: PhaseRecord, gateResults: GateResult[]) => Promise<CheckpointDecision>;
```

### Runtime-record additions

| Type | Field | Set by | Why |
|---|---|---|---|
| `RunRecord` (`run-registry.ts`) | `cwd: string` | spawn | widget cross-cwd filter |
| `RunRecord` | `backend: BackendId` | spawn | probe dispatch (pi→handle, claude→pid) |
| `RunRecord` | `pid?: number` | spawn (claude only) | cross-process PID probe |
| `LiveSessionHandle` (`spawnSubagent.ts`) | `isAlive(): boolean` | backend impl | real in-process probe |
| `RunMetaEvent` (`run-log.ts`) | `pid?: number`, `cwd: string` | spawn | cross-process durability |

### Frontmatter declaration syntax

```yaml
phases:
  - name: implement
    skills: [executing-plans, test-driven-development]
    gates:
      - verification-before-completion       # name only → registry onFail/params
      - completenessCheck
      - { name: gate, params: { costCap: 2.00 } }   # override params per-phase
    challengeStep: true                      # default; omit or set false to opt out
    checkpoint: false
```

### Updated default lifecycle (`default.ts`)

Gates add value where the phase produces something checkable; creative/trivial phases stay lean:

| Phase | `gates` | `challengeStep` | Rationale |
|---|---|---|---|
| brainstorm | `[]` | `true` | produces a design doc — no tests to verify; checkpoint reviews the doc. Challenge-step nudges self-critique of the design. |
| plan | `[completenessCheck]` | `true` | the plan file should exist before checkpoint. |
| implement | `[verification-before-completion, completenessCheck, gate]` | `true` | the headline gate stack — tests pass, files exist, cost bounded. |
| review | `[]` | `true` | this phase *is* the review; adding `verify` (another reviewer) is redundant. |
| finish | `[]` | `false` | trivial merge/PR — no work to challenge. |

The `gate` (cost-cap) runs only on `implement` — the phase that spends the most. Users can add `verify` to any phase via custom lifecycles.

### `pi.registerGate` extension hook

```ts
pi.registerGate({
  name: "my-custom-gate",
  kind: "predicate",
  onFail: "advise",
  run: async (ctx) => { /* ... */ return { passed, evidence }; },
});
```

The path for deferred `judgePanel`/`loopUntilDry` — they land as registered gates in a follow-up SPEC, no seam changes.

## 7. `/fleet` Lifecycle view — gate chain + evidence rendering

No new view/tab — the Lifecycle view matures in place (interactive-first).

### Phase row shape

| Element | Today | SPEC-6-2 |
|---|---|---|
| Phase status glyph | `▶` running / `✓` completed / `✗` failed / `⏸` checkpoint | same |
| Phase line | `▶ implement  [running]  27K tok  $0.42` | same + a gate line below when `gates` ran |
| Gate line | — | `gates: ✅ verification-before-completion  ✅ completenessCheck  ⛔ gate → aborted` |
| Gate evidence | — | compact inline; full evidence (e.g. `verify` review text) on row expand |

### Gate status glyphs

| Glyph | Meaning | `onFail` |
|---|---|---|
| ✅ | passed | (any) |
| ⛔ | failed → abort (lifecycle ended) | `abort` |
| ↻ | failed → revise (phase re-running) | `revise` |
| ⚠ | failed → advise (evidence passed to checkpoint) | `advise` |
| 💀 | gate spawn crashed (reviewer errored) | `advise` (verify-only) |

### Action submenu (Lifecycle view)

| Action | Today | SPEC-6-2 |
|---|---|---|
| Continue / Revise / Abort (checkpoint) | yes | yes — the checkpoint prompt surfaces gate evidence to the human |
| Steer / Stop | yes | yes |
| **View gate evidence** | — | NEW — opens the conversation viewer on the agent gate's runId (for `verify`); predicate gates show a static evidence panel |
| **Re-run gate** | — | NEW — re-runs a single gate on the current phase output (cheap re-check; useful after a `verify` crash) |

### Progress-notes sync (`updateProgress`)

The lifecycle todo's progress block gains the gate outcome in its `last` line:

| Today | SPEC-6-2 |
|---|---|
| `implement completed — src/foo.ts, src/bar.ts` | `implement completed — src/foo.ts, src/bar.ts · gates: ✅vbc ✅cc ✅gate ⚠verify` |

### What does NOT get a panel surface

| Item | Why |
|---|---|
| `challenge-step` hook | prompt injection — no runtime state to surface (no honest signal) |
| `session-liveness` probe | infrastructure — it just clears stale rows. The *effect* (no ghost ▶ row) is visible; the probe itself isn't a user-facing concept. A reconcile log line ("reconciled 1 orphan") already exists from v0.10.2. |

## 8. Scope boundaries + carry-forward

### IN scope (→ v0.11.0)

- Gate chain seam in `run-lifecycle.ts`
- 4 builtin gates (`verification-before-completion`, `completenessCheck`, `gate`, `verify`)
- GateRegistry + `pi.registerGate` hook
- `challenge-step` soft injection (lifecycle-wide via `renderPhasePrompt`)
- `session-liveness` hybrid probe (`probeRun` + `isAlive()` + `pid` on `RunRecord`/`run:meta`)
- Cross-cwd leak fix (`RunRecord.cwd` + widget filter)
- Updated default lifecycle (gates per phase + challenge-step)
- `/fleet` Lifecycle view maturity (gate line + glyphs + View-evidence / Re-run-gate actions)
- Widened `CheckpointFn` (`(phase, gateResults)`)
- Periodic liveness timer
- Adjacent: `emitProgress` reads `RunRecord.backend` instead of hardcoding `"pi"`

### NOT in 6-2 (deferred)

| Item | Deferred to |
|---|---|
| `judgePanel` (multi-agent panel) | follow-up sub-SPEC (6-2.1 or folded into 6-3) |
| `loopUntilDry` (repeat-until-stable) | follow-up sub-SPEC |
| Workflows-as-code | SPEC-6-3 |
| Event-bus RPC + live conversation viewer → v1.0 | SPEC-6-4 |

### Carry-forward interactions

| Carry-forward item | 6-2 action |
|---|---|
| Cross-cwd / shared-RunRegistry leak | **CLOSED** — `cwd` tag + widget filter + probe-driven reconcile |
| Double-finishRun + runId-reuse retry (`spawnSubagent` writes `run:meta` twice L217+L283; abort-then-complete fires `finishRun` twice) | **adjacent fix** — dedup the optimistic `run:meta`, guard `finishRun` against double-fire. Flagged in the plan; not a design seam. |
| `fleet.maxConcurrentBg` settings read (deferred SPEC-5a) | not touched |
| `emitProgress` hardcodes `backend: "pi"` | **adjacent fix** — now reads `RunRecord.backend` (we touch the field anyway) |
| Claude-backend steer probe | not touched (SPEC-3 territory) |
| `npm audit` 2 vulnerabilities | not touched (separate triage) |

### Version + release

| | |
|---|---|
| Target version | `v0.11.0` |
| Branch | `feat/spec-6-2-quality-gates` |
| Commit prefix | `feat(spec-6-2): …` / `fix(spec-6-2): …` / `test(spec-6-2): …` |
| Release flow | branch → PR → `gh pr merge --merge --delete-branch` → tag `v0.11.0` → CI publish → bump `settings.json` → term-smoke on published |
| Compatibility | pi `^0.81.1` (unchanged) |

### Known limitations (documented in the spec, not enforced)

- `verify` `passed` heuristic is fuzzy — benign because `onFail:"advise"` (the human sees the full review regardless).
- `verification-before-completion` evidence scan is heuristic — a phase that ran tests in an unusual format might false-fail → revise. Tunable via `params.patterns`.
- Cross-process pi-backend orphans keep the age+grace fallback — no pid (in-process), no reachable handle. The honest fallback.
- No metered model in this env for smoke — the `gate` cost-cap path is unit-tested with a fake metered backend; a live term-smoke of the cap-trip needs OpenRouter Anthropic or a direct key (not in catalog here).

## 9. Testing strategy

Following the existing patterns (node:test via tsx, `--test-timeout=30000`; pure fns unit-tested, panel class term-smoke-gated per the `buildFleetItems` precedent).

### Unit tests (new + extended)

| Test file | Status | Covers |
|---|---|---|
| `src/lifecycle/gates/chain-runner.test.mts` | NEW | short-circuit on `revise`/`abort`; `advise` continues + collects; all-pass → checkpoint fires with `GateResult[]`; revise-budget interaction; empty gates → no-op |
| `src/lifecycle/gates/verification-before-completion.test.mts` | NEW | fixture outputs with evidence → pass; bare claims → fail; `params.patterns` override |
| `src/lifecycle/gates/completeness-check.test.mts` | NEW | all paths exist → pass; missing path → fail; worktree-path variant |
| `src/lifecycle/gates/gate.test.mts` | NEW | `cost < cap` → pass; `cost > cap` → fail; `context > floor` → fail; `params` override; missing tier → skip |
| `src/lifecycle/gates/verify.test.mts` | NEW | positive review → pass; failure markers → fail; spawn crash → advise; `cost`/`runId` on result; `params.agent` pin |
| `src/lifecycle/gates/registry.test.mts` | NEW | register/lookup; `pi.registerGate` hook; name collision |
| `src/lifecycle/run-lifecycle.test.mts` | EXTENDED | gate chain integration: `GateResult[]` thread to `onCheckpoint`; gate-revise re-runs phase; gate-abort ends lifecycle; backward-compat (no `gates` → unchanged) |
| `src/lifecycle/prompt-template.test.mts` | EXTENDED | `challenge-step` block injected by default; `challengeStep:false` omits it |
| `src/engine/run-registry.test.mts` | EXTENDED | `cwd`/`backend`/`pid` fields round-trip |
| `src/runtime/reconcile.test.mts` | EXTENDED | `probeRun`: handle `isAlive:false` → dead; `pid` dead → dead; cross-process pi fallback (age > grace) → dead; alive → not aborted; cross-cwd widget filter |
| `src/runtime/run-log.test.mts` | EXTENDED | `run:meta` with `pid`/`cwd` round-trips through `scanMeta` |
| `src/panel/fleet-items.test.mts` | EXTENDED | gate-line rendering (pure fn): glyphs per `onFail`, evidence excerpt, empty-gates row |

### Integration (in-process, via existing `runLifecycle` test harness)

| Scenario | Asserts |
|---|---|
| Full gated lifecycle, all gates pass | `onCheckpoint` receives `gateResults` all-passed; lifecycle completes |
| `verification-before-completion` fails on `implement` | revise loop fires; phase re-runs with gate feedback; completes on 2nd attempt (fixture w/ evidence) |
| `gate` cost-cap breaches on `implement` | lifecycle `failed` with the gate's evidence; no checkpoint fired |
| `verify` advises on `review` | checkpoint receives the review evidence; human (fake) continues |
| Liveness probe: orphaned in-process run | `probeRun` returns dead via `isAlive:false`; reconcile aborts in log + registry |

### Term smoke (panel class — not unit-tested, per the `buildFleetItems` precedent)

| Gate | Smoke step | Asserts |
|---|---|---|
| `verification-before-completion` | run a gated lifecycle on a real task | Lifecycle view shows `✅ verification-before-completion` on implement |
| `completenessCheck` | same | `✅ completenessCheck` |
| `gate` (cost) | Ollama-$0 run | `✅ gate` (cap not tripped at $0); cap-trip path is unit-test-only (no metered model — Known Limitations) |
| `verify` | run a gated lifecycle | `⚠ verify` row appears with expandable review text |
| Liveness probe | reproduce the v0.10.2 orphan (kill a run mid-phase) | the ghost ▶ row clears without a restart (periodic timer) |

### The lesson from v0.10.1, applied

The v0.10.1 Runs-ctx% gap slipped because a pure fn was unit-tested but the panel wiring wasn't checked at review time. For 6-2, when a Task wires a pure fn (gate-line rendering) into the panel, the plan includes a **review-time grep check** that the panel actually passes the gate results to the renderer — the term smoke is the net, but the grep catches it cheaper.

### Coverage target

- New code: 80%+ (project standard)
- Gate chain runner: 100% branch (short-circuit paths are the risk surface)
- `probeRun`: 100% branch (the three probe paths + fallback)
- Panel class: term-smoke-gated (not counted in unit coverage — the precedent)

## 10. References

- Master PRD: `PRD.md` §8 (SPEC-6 line — "quality patterns + lifecycle hooks baked in")
- SPEC-6-1 design: `docs/superpowers/specs/2026-07-27-spec-6-1-design.md` (the foundation — cost/tier/context surfaces 6-2 reads)
- Existing lifecycle: `src/lifecycle/lifecycle-types.ts`, `src/lifecycle/run-lifecycle.ts`, `src/lifecycle/default.ts`
- v0.10.2 reconcile: `src/runtime/reconcile.ts` (the age+grace heuristic this SPEC retires)
- Superpowers skills: `~/.pi/agent/skills/verification-before-completion/SKILL.md`, the AGENTS.md "Challenge Step" section
- Session handoff: `~/Documents/secret/strategy/getpipher/armory-fleet/session-handoff-2026-07-28.md` (the v0.10.2 bug hunt that surfaced the liveness gap + the Q1 framing)