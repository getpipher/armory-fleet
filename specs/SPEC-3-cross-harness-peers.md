# SPEC-3 — Cross-harness peers (CC + Pi backends)

> **Status:** DRAFT (brainstorming output, pre-plan) · **Owner:** RECTOR · **Created:** 2026-07-24
> **Package:** `@getpipher/armory-fleet` · **Lands as:** `v0.3.0`
> **PRD reference:** [`../PRD.md`](../PRD.md) §8 SPEC-3 · **Predecessors:** [SPEC-1](./SPEC-1-core-engine-todo-sync.md), [SPEC-2](./SPEC-2-deep-armory-integration.md)

---

## 1. Overview & goals

SPEC-3 makes the fleet **dual-arsenal**: a `subagent` run targets one of two backends — **Pi** (the SPEC-1/2 SDK-session child) or **Claude Code** (`claude -p` child process) — chosen by the agent profile's `backend` frontmatter field. The engine stays backend-agnostic; a new `BackendRegistry` routes. The moat (memory-hydrate / vision / `todo`-exclusion / no-leakage) extends into the CC backend through *its* native mechanisms (prompt-baking + flag translation), with the one genuine gap (CC vision has no `describe_image` fallback) declared visibly in a per-backend armory chip. Backend-native `session_key` resume works in both. A new `/fleet` Backends view shows backend availability, version, schema, and hook parity.

**In scope (v0.3):**
- `backend: "pi" | "claude"` frontmatter field (profile pins backend; Q2=A).
- `sessionKey` frontmatter field (default = profile name) + backend-native resume (Q3=A).
- `BackendRegistry` + `Backend` descriptor (Q5=B) — the data source for routing + the Backends view.
- `createClaudeChildFactory` + `ClaudeChildSession` — the CC adapter (streaming `claude -p --output-format stream-json`; Q4=A).
- The moat translated into CC: memory via `--append-system-prompt`; `todo` via `--disallowed-tools`/`--allowed-tools` (prompt-nudge fallback); vision pass-through-only (Q1=B, the `v~` gap declared).
- `detectClaude()` version + stream-json schema smoke at init; fail-loud at the backend (Q4=A).
- `/fleet` Backends view (read-only) + Agents-view backend badge.
- `general-purpose-cc` builtin (sibling to `general-purpose`).

**Out of scope (deferred — §12):** fan-out synthesis primitive; per-spawn `backend` override; cross-backend resume (session hops Pi→CC); `BackendPort` interface lift; Codex backend; per-backend model list in Backends view; inline Backends editing; async/background CC runs; cost-accounting normalization.

**Done bar (v0.3):** A profile with `backend: claude` spawns a real `claude -p` child through the CC factory; the run is memory-hydrated, `todo`-excluded, and tracked in armory-todo like any Pi run; vision is pass-through-only with the gap visible in the chip; `session_key` resume works in both backends; the `/fleet` Backends view renders availability + version + schema + hook parity; `claude` absent or schema-drifted fails loud at the backend. Day-one dual-arsenal via `general-purpose` (pi) + `general-purpose-cc` (claude) builtins; fan-out = parent calls `subagent` twice.

**Competitive dimension (PRD §8 SPEC-3):** Dual-arsenal — only kky42 attempts, weakly. Fleet ships it with a visible, honest hook-parity contract + native resume in both backends.

---

## 2. Architecture — the `BackendRegistry`

### 2.1 The creation seam is unchanged; the metadata is new

SPEC-1 established `ChildSessionFactory` (`create(opts) => {session, model}`) as the backend-agnostic creation seam. SPEC-3 does **not** rename it a `BackendPort` (Q5=B — YAGNI for two backends). Instead, SPEC-3 adds a `BackendRegistry` that maps a backend id → a `Backend` descriptor holding the factory *plus* the metadata Q1/Q4 need:

```ts
interface Backend {
  id: "pi" | "claude";
  factory: ChildSessionFactory;
  available: () => boolean;                  // pi → true (always); claude → detect result (cached)
  versionInfo: () => BackendVersionInfo | null;
  hookParity: BackendHookParity;             // declared constant, not inferred
}
```

The engine consults `registry.get(agentDef.backend).factory`; the Backends view reads `registry.list()`. The creation seam (`ChildSessionFactory`) is SPEC-1's, untouched.

### 2.2 The two backends

| Backend | Factory | Available | Hook parity |
|---|---|---|---|
| `pi` | `createChildSessionFactory` (SPEC-2, unchanged) | always `true` | `t✓ m✓ v✓` |
| `claude` | `createClaudeChildFactory` (SPEC-3 NEW) | `detectClaude()` result (cached at init) | `t✓ m✓ v~` |

### 2.3 The moat boundary (Q1=B made concrete)

The moat is fleet-owned orchestration applied *through* each backend's native mechanisms. Pi gets it via loader injection (`CustomResourceLoader` + `customTools` + `excludeTools`); CC gets it via prompt/flag translation (`--append-system-prompt` + `--disallowed-tools`). The contract is the `Backend.hookParity` struct — **declared per backend, read by the view, never inferred at spawn time**. Where a hook can't be delivered (CC vision fallback), the chip says so (`v~`), and §12 records the gap.

### 2.4 The resume boundary (Q3=A)

`sessionKey` is a per-profile stable id (default = profile name). On spawn, each backend persists its native session id into `runRecord.backendSessionId` (Pi: file-backed `SessionManager` session id; CC: the `session_id` from the stream-json init event). On a re-spawn of the same `sessionKey`, the engine feeds that id to the backend's resume primitive. **Sessions never hop backends** — each backend resumes its own.

### 2.5 What does NOT change

`spawnSubagent`'s shape, the `subagent` tool params, the turn budget, the concurrency lock, the todo-sync port, the run registry, the Agents/Fleet views. SPEC-3 is *additive*: one new factory, one registry, two new frontmatter fields, one new view, the CC adapter module, one small Pi-factory change (inMemory → file-backed `SessionManager` for resume). The PRD §8 `.pi/subagents/` wording is reconciled → profiles stay in `.pi/agents/` (+ `~/.pi/agent/agents/` + builtins); `backend` is a frontmatter field on the same files.

---

## 3. Components (file layout — additions/changes vs SPEC-2)

SPEC-3 is additive. **NEW** files are new; **MOD** files are modified. All under `src/`.

```
src/backend/                       (NEW module)
├── registry.ts                    NEW  BackendRegistry + Backend descriptor
├── hook-parity.ts                 NEW  BackendHookParity type + declared values
├── claude-detector.ts             NEW  detectClaude(): version + stream-json schema smoke
├── claude-factory.ts              NEW  createClaudeChildFactory → ChildSessionFactory
├── claude-session.ts              NEW  ClaudeChildSession: ChildSession over child proc
├── claude-events.ts               NEW  NDJSON stream parser → ChildSessionEvent mapper
├── resume-store.ts                NEW  sessionKey → backendSessionId (file-backed, per backend)
└── port.ts                        NEW  type re-exports (Backend, BackendHookParity, …)

src/engine/spawnSubagent.ts        MOD  +backendRegistry lookup; +runRecord.backendSessionId/sessionKey
src/registry/frontmatter.ts        MOD  +backend, +sessionKey fields + validation
src/registry/builtins/             MOD  general-purpose.md unchanged; + general-purpose-cc.md
src/panel/index.ts                 MOD  +Backends tab
src/panel/backends-view.ts         NEW  registry.list() → rows; r:Refresh; i:Info
src/index.ts                       MOD  wire BackendRegistry; detectClaude() at init

scripts/spec-3-smoke.mts           NEW  full-run smoke (real claude -p) — NOT in CI
test/backend-registry.test.mts     NEW
test/claude-detector.test.mts       NEW  mocked claude --version + schema smoke
test/claude-events.test.mts        NEW  NDJSON fixtures → ChildSessionEvent
test/claude-session.test.mts       NEW  prompt/subscribe/abort/dispose over fake child proc
test/frontmatter-backend.test.mts NEW  backend + sessionKey parsing + validation
test/resume-store.test.mts         NEW  set/get/clear per backend; file round-trip
test/spawn-claude-smoke.test.mts   NEW  real-pi smoke: real claude -p if available, else skip
```

**Net:** ~8 new source files, ~4 modified, 1 new builtin, 1 new smoke script, 7 test files. The Pi factory (`createChildSessionFactory`) and all SPEC-2 modules (`child-loader`, `memory-hydrate/`, `vision/`, `todo-sync/`) are **untouched** except the one-line Pi-factory `SessionManager.inMemory()` → file-backed change (§3.1).

### 3.1 The one SPEC-2 module touched: Pi factory `SessionManager`

To enable Pi-side resume, `createChildSessionFactory` switches from `SessionManager.inMemory()` to a file-backed manager (so the session id survives across spawns). Contained: one line + the resume-store write/read around it. No behavior change for non-resume runs (a fresh `sessionKey` simply starts a new file-backed session). Recorded as the only SPEC-2 surface SPEC-3 touches.

---

## 4. The CC adapter — `claude -p` → `ChildSession`

### 4.1 The invocation

The CC factory spawns `claude` in streaming interactive mode:

```
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --model <m>                          # omitted if agentDef.model unset → CC default
  --append-system-prompt "<mem + role>" # Q1=B memory baking
  --disallowed-tools "todo"             # if --disallowed-tools supported (version-detect)
  --allowed-tools "<allow-list>"        # when agentDef.tools pins tools (enforces todo exclusion)
  --max-turns <n>                       # if supported (version-detect)
  --resume <backendSessionId>           # when resume-store has an id for sessionKey
```

**Model string:** `agentDef.model` for a CC profile is a CC model identifier passed verbatim to `--model`. Fleet does **not** parse `provider/id` for CC (that's a Pi convention). Omitting `model` → no `--model` flag → CC default.

### 4.2 NDJSON stream → `ChildSessionEvent` mapping (`claude-events.ts`)

| CC NDJSON event | Fleet `ChildSessionEvent` | Notes |
|---|---|---|
| `{type:"system", subtype:"init", session_id, …}` | forwarded as `{type:"session_init", backendSessionId}` | capture + persist to resume-store; the engine reads it to stamp `runRecord.backendSessionId` (§4.3, §7) |
| `{type:"assistant", message:{role:"assistant", content:[{type:"text",text}]}}` | `{type:"message_end", message:{role:"assistant", content:[{type:"text", text}]}}` | `finalText` accumulation |
| `{type:"assistant", message:{usage:{…}}}` | merged into the same `message_end` | `usage.cost.total` computed from CC token fields (× per-token cost, or CC's own cost field if present) |
| `{type:"result", subtype:"success"\|"error_max_turns"\|…}` | `{type:"turn_end"}` | drives turn budget; `error_max_turns` → `failed` run |
| `{type:"user", …}` *(echo of our stdin write)* | *(filtered)* | not fed back to the engine |
| `{type:"error", …}` | surfaced as a run error | session rejects; engine records `runError` |

**Unknown event types** are logged at debug + forwarded as-is (forward-compat; CC may add types we don't need). The schema smoke catches whole-shape drift (init missing `session_id`) → backend `available:false`.

### 4.3 `session_id` capture + resume lifecycle

**On init event:** `ClaudeChildSession` (1) stashes `session_id` on the instance, (2) writes `resumeStore.set("claude", sessionKey, session_id)`, (3) forwards a fleet-internal `{type:"session_init", backendSessionId}` event through `subscribe` (the engine's handler stamps `runRecord.backendSessionId` + `runRecord.sessionKey`). This adds an optional `backendSessionId?: string` field to `ChildSessionEvent` (`src/engine/spawnSubagent.ts`) — the only change to the `ChildSession`/`ChildSessionEvent` contract in SPEC-3; Pi's factory emits the same `session_init` event once its file-backed `SessionManager` session id is known.

**On re-spawn** of the same `sessionKey`: the factory reads `resumeStore.get("claude", sessionKey)` → if present, passes `--resume <id>`; CC replays its own history natively (no transcript normalization). **Stale-id fallback:** if `--resume` fails (CC evicted the id), the factory catches the error, clears the resume-store entry, re-spawns *without* `--resume` (fresh session), and surfaces a visible warning to the parent. Never a silent failure.

**Pi side (symmetry):** the Pi factory captures the file-backed `SessionManager` session id, writes `resumeStore.set("pi", sessionKey, id)`, and on re-spawn calls `SessionManager.resume(id)` with the same stale-id fallback.

### 4.4 `prompt` / `abort` / `dispose`

- **`prompt(text)`**: writes `{type:"user", message:{role:"user", content:[{type:"text", text}]}}\n` to stdin; resolves when the matching `result` event arrives (turn boundary, not session end — session stays alive for resume). Matches Pi's `session.prompt` semantics.
- **`abort()`**: `proc.kill("SIGTERM")`. Stream close → synthetic `turn_end` (so the budget path isn't bypassed) → engine records `status:"aborted"`. Hard kill is the only mechanism; abort is best-effort cancellation.
- **`dispose()`**: `proc.kill()` (SIGKILL if alive) + `stdout.destroy()` + `stdin.end()` + remove listeners. Idempotent. Called by the engine in `finally`.

### 4.5 Turn budget mapping

- Pass `--max-turns <n>` if supported (version-detect records it); CC stops itself.
- Fleet's `turn_end` counter is the **belt**: excess `turn_end` events → engine `budget.consume()` → `session.abort()`.
- CC `result.subtype === "error_max_turns"` → `failed` run with `"hit turn budget"` (same message shape as Pi, consistent regardless of backend).

### 4.6 The moat in CC (recap)

| Hook | Pi (SPEC-2, unchanged) | CC (SPEC-3) | Parity |
|---|---|---|---|
| memory-hydrate (3-scope) | `CustomResourceLoader` composes `systemPromptOverride` | `--append-system-prompt` with the same `memoryPort.renderScopes()` string | `m✓` |
| `todo` excluded | `excludeTools:["todo"]` + `noExtensions:true` | `--disallowed-tools`/`--allowed-tools` (kebab-case; exact names confirmed by `detectClaude()`) + prompt-nudge fallback | `t✓` |
| vision (capability-aware) | `describe_image` injected via `customTools` iff child text-only | pass-through only (CC's own model multimodal); **no fallback** | `v~` |
| no host-extension leakage | `noExtensions:true` | inherent (CC has no fleet extensions) | ✓ |

The `v~` is the one declared gap, visible in `Backend.hookParity.vision = "~"` → Backends view + Agents chip → never a spawn-time surprise.

---

## 5. The CC detector + version-detect (`claude-detector.ts`)

Runs once at extension init (cached on the `Backend` descriptor):

1. **`claude --version`** → parse version; missing/unparseable → `null` (backend unavailable).
2. **Schema smoke**: spawn a throwaway `claude -p --output-format stream-json "ping"`; read the init event; confirm shape `{type:"system", subtype:"init", session_id, …}`.
3. **Flag support probe**: check `claude --help` (or a version-table) for `--disallowed-tools` / `--allowed-tools` / `--max-turns` / `--resume` support (kebab-case; exact names confirmed here, not hardcoded in the factory) → records the flag matrix the factory consults.
4. Return `{ version, schemaOk, flagSupport, note? }`.

**Fail-loud at the backend (Q4=A):** if `schemaOk=false`, the `claude` backend is registered `available:false` with a note; `backend:claude` profiles fail fast at spawn with the actionable error ("claude backend unavailable: schema drift — fleet supports CC ≥ <x>"). Never a silent degradation.

---

## 6. Frontmatter schema additions

Extending SPEC-1 §7.2 / SPEC-2 §6 with two new fields. Pattern unchanged: named field, sensible default, toggleable — the moat/routing as a visible contract.

| Field | v0.3 | Default | Notes |
|---|---|---|---|
| `backend` | ✅ | `"pi"` | `"pi"\|"claude"`; pins the profile's backend (Q2=A). Invalid → `FrontmatterError` listing valid backends. |
| `sessionKey` | ✅ | profile `name` | stable id for backend-native resume (Q3=A). Set explicitly to share resume state across differently-named profiles (rare). |

**`AgentDef` diff:**
```ts
+ backend: "pi" | "claude";   // default "pi"
+ sessionKey: string;          // default = name
```
`parseAgentFile` validates `backend` against the registry's known ids (typo `backend: claud` caught at load, not spawn).

### 6.1 The builtins

`general-purpose` (unchanged, `backend` implicit `pi`) stays the Pi day-one agent. New **`general-purpose-cc.md`**:
```md
---
name: general-purpose-cc
description: A focused general-purpose CC subagent. Use for any task needing Claude Code as the worker.
backend: claude
todoSync: true
memoryHydrate: true
vision: true
---
You are a focused subagent delegate running under Claude Code. Complete the assigned task
thoroughly, work autonomously to completion, and return a concise result summary.
Do not call the `todo` tool — the fleet engine manages todo tracking for you.
```
Same role prompt as the Pi builtin (deliberate — dual-arsenal visible at rest as sibling profiles); only `backend` differs. Day-one fan-out: `subagent(general-purpose, …)` + `subagent(general-purpose-cc, …)`.

---

## 7. The spawn lifecycle — what changes from SPEC-1 §5 / SPEC-2 §7

The engine gains one lookup + two run-record fields; everything else is unchanged.

1. Resolve `agentDef` (unchanged).
2. **NEW:** look up `backend = registry.get(agentDef.backend)`. If missing/unavailable → `fail(runId, "backend '<backend>' unavailable: <note>")`.
3. Resolve model (unchanged; CC factory passes verbatim, doesn't parse `provider/id`).
4. Resolve tools/memory/vision ports (unchanged; the CC factory consumes the same ports).
5. **NEW:** read `resumeStore.get(backend.id, agentDef.sessionKey)` → pass to the factory as `resumeId`.
6. Spawn child via `backend.factory.create(opts)` (unchanged interface).
7. Subscribe, run, budget, abort — unchanged.
8. **NEW:** the session emits `{type:"session_init", backendSessionId}` through `subscribe` (§4.3); the engine stamps `runRecord.backendSessionId` + `runRecord.sessionKey`.
9. Finish run + todo-sync reconciliation (unchanged).

`SpawnOptions.childFactory` is replaced by `SpawnOptions.backendRegistry: BackendRegistry` (the engine looks up the factory). Unit tests inject a fake registry with a fake backend (same test-injection pattern SPEC-1/2 used for the factory).

---

## 8. The `/fleet` panel — Backends view + Agents-view badge

### 8.1 Backends view (NEW tab)

Read-only in v0.3 (power-knobs are SPEC-6). One row per `registry.list()`:

| id | available | version | schema | armory chip |
|---|---|---|---|---|
| pi | ✓ (always) | pi 0.81.1 | — | `t✓ m✓ v✓` |
| claude | ✓ / ✗ | 1.x.y | ✓ / ✗ | `t✓ m✓ v~` |

- **available** — `Backend.available()` (cached from init; `r:Refresh` re-runs `detectClaude()`)
- **version** — `Backend.versionInfo()?.version` (`—` if n/a)
- **schema** — `Backend.versionInfo()?.schemaOk` (✓/✗/`—`); ✗ shows the `note` inline
- **armory chip** — `Backend.hookParity` as `t✓ m✓ v~` (same chip style as Agents view, sourced from the same `BackendHookParity` type)

**Action submenu:** `r:Refresh` (re-detect) · `i:Info` (full version + schema-smoke result + flag-support matrix + hook mechanism notes, e.g. vision: "pass-through only; no `describe_image` fallback — `customTools` not injectable into `claude -p`").

**No inline `Input`** (read-only). The EditorTheme gotcha applies if a future action opens an editor; for now it's a pure list + detail pane, same pattern as Agents `i:Info`.

### 8.2 Agents view — backend badge

The per-profile armory chip (SPEC-2) gains a **backend prefix**:
```
general-purpose       [pi]    armory:[t✓ m✓ v✓]
general-purpose-cc    [claude] armory:[t✓ m✓ v~]
```
The chip is read from `registry.get(agentDef.backend).hookParity` (declared, not inferred). A glance at the Agents view shows the dual-arsenal at rest.

---

## 9. Guards (SPEC-1/2 §9 carried forward)

### 9.1 `todo` excluded — CC enforcement
Pi: `excludeTools:["todo"]` + `noExtensions:true` (SPEC-2 hardened, unchanged).
CC: `--disallowed-tools "todo"` (or `--allowed-tools` allow-list) when supported (kebab-case; exact flag names confirmed by `detectClaude()`); prompt-nudge "Do not call the `todo` tool" fallback when the flag is unavailable. Belt-and-suspenders, same flavor as Pi. Chip stays `t✓` (enforced, just via a different mechanism).

### 9.2 Single-writer discipline — generalized
The armory-todo single-writer invariant (SPEC-1 §9.1, SPEC-2 §9.2) holds across backends: the **child never writes to armory-todo**; only the fleet engine does (linkOrCreate/markDone/markReverted). CC's own todo tool (if any) is excluded/disabled; even if it weren't, it writes to CC's own store, not armory-todo — no conflict, but the exclusion keeps the contract clean.

### 9.3 Concurrency=1, turn budget, Esc-abort — unchanged
SPEC-1 §9.2/§9.3 carry forward unchanged. The CC backend participates in the same single-slot lock + turn budget + abort path.

### 9.4 No host-extension leakage — inherent in CC
CC has no fleet extensions to leak; the `noExtensions:true` guard is Pi-specific (and unchanged there).

---

## 10. Error handling

| Failure | Detection | Behavior |
|---|---|---|
| `claude` not installed | `detectClaude()` → `null` at init | `claude` backend `available:false`; Backends view shows "not installed"; `backend:claude` profiles fail fast at spawn |
| `claude` installed, stream-json schema drifted | schema smoke fails | `available:false` + `note:"schema drift (got <shape>)"`; same fail-fast at spawn |
| `--disallowed-tools` unsupported on this CC version | flag-support probe records it | factory uses prompt-nudge fallback; chip stays `t✓`; debug log notes the flag was unavailable |
| `--resume <id>` fails (stale id) | spawn-time CC error | factory clears the resume-store entry, re-spawns fresh, surfaces a visible warning |
| child process crashes mid-run | stream closes unexpectedly | `dispose()` + run `failed` with last partial `finalText` |
| stdin write fails (child gone) | write error | run error; `dispose()` |
| `backend` frontmatter invalid | `parseAgentFile` validates against registry ids | `FrontmatterError` with actionable message at load |
| `backend` id not in registry (e.g. plugin unloaded) | engine lookup at spawn | fail-fast `fail(runId, "backend '<id>' unavailable")` |

All errors are actionable + traceable (per the global constraint). No silent failures.

---

## 11. Testing

### 11.1 Unit (mocks — no real `claude`)
- `backend-registry.test.mts` — register/get/list; hookParity declared; unknown id → undefined.
- `claude-detector.test.mts` — mock `claude --version` (present/missing/garbage) + mock schema smoke (init shape matches/drifts); flag-support probe.
- `claude-events.test.mts` — NDJSON fixtures → `ChildSessionEvent` mapping; init capture; turn_end from `result`; unknown event forwarded; error event → run error.
- `claude-session.test.mts` — prompt writes NDJSON to stdin; subscribe receives mapped events; abort kills; dispose is idempotent; resume-id capture writes to resume-store.
- `frontmatter-backend.test.mts` — `backend`/`sessionKey` parse + defaults + invalid `backend` error; `sessionKey` defaults to name.
- `resume-store.test.mts` — set/get/clear per backend; file-backed round-trip; stale-entry clear on failed resume.

### 11.2 Real-pi smoke matrix (`term`-driven + `scripts/spec-3-smoke.mts`)
The EditorTheme-gotcha lesson (SPEC-2 §11.2) carries forward — smoke inside real pi before release.

| Row | Action | Expected |
|---|---|---|
| 1 | extension loads with `claude` absent | Backends view shows `claude: available ✗ (not installed)`; `pi: ✓` |
| 2 | `subagent(general-purpose, "reply OK")` (pi) | run completes; `finalText` non-empty; armory chip `t✓ m✓ v✓` |
| 3 | `subagent(general-purpose-cc, "reply OK")` (claude, if available) | run completes via `claude -p`; `backendSessionId` set; chip `t✓ m✓ v~` |
| 4 | re-spawn `general-purpose-cc` same `sessionKey` | `--resume <id>` passed; CC replays history |
| 5 | `backend: invalid` profile in `.pi/agents/` | load error surfaced; profile excluded from registry |
| 6 | `claude` schema drift (simulate by pointing at a fake `claude`) | Backends view shows `schema ✗`; spawn fails fast with actionable error |
| 7 | Backends view `r:Refresh` | re-runs `detectClaude()`; row updates |

`scripts/spec-3-smoke.mts` runs rows 2–4 against real `claude -p` (if installed) — NOT in CI (real CC call costs tokens). Rows 1/5/6/7 are `term`-driven (no CC call). The smoke script skips cleanly when `claude` is absent (exit 0 + a "skipped" note), so it's safe to run anywhere.

### 11.3 Coverage bar
80%+ on new code (per global standard). The CC event mapper + session + detector are the highest-value coverage targets.

---

## 12. Deferred (recorded, with landing SPEC)

| Deferral | Landing SPEC | Why deferred |
|---|---|---|
| Fan-out **synthesis** primitive (auto-merge two subagent results) | SPEC-6 | workflows-as-code (`parallel`/`pipeline`); v0.3 fan-out = parent calls twice |
| `backend` per-spawn **override** (tool/panel) | SPEC-6 | Q2=A pins backend to the profile; override is a power-knob |
| **Cross-backend** resume (session hops Pi→CC) | never / SPEC-6+ | Q3=A — not a real use case; needs shared transcript format |
| Third **`BackendPort` interface** (lift registry → port) | when 4th/third-party backend lands | Q5=B — two backends don't justify a port; YAGNI |
| **Codex backend** | post-v1 | PRD §9 — RECTOR's dual-arsenal is CC + Pi; Codex later |
| Per-backend **model list** in the Backends view | SPEC-5b/SPEC-6 | needs a CC flag to enumerate models; v0.3 shows version + schema only |
| **`/fleet Backends` inline editing** (add/configure backends) | SPEC-6 | power-user tier; v0.3 is read-only + refresh |
| **Async/background CC runs** | SPEC-5a | v0.3 is foreground synchronous (concurrency=1 inherited) |
| **Cost accounting** (per-backend token cost normalization to $) | SPEC-6 | Q4=A captures CC token fields; normalization is a SPEC-6 cost-aware tier concern |
| Pi factory `SessionManager.inMemory` → file-backed | — | recorded: the resume feature forces this one-line change; contained, no behavior change for non-resume runs |

Nothing silently dropped; every deferral recorded with its landing SPEC. The PRD §8 `.pi/subagents/` wording is reconciled here → profiles stay in `.pi/agents/` (+ global + builtins); `backend` is a frontmatter field on the same files (same flavor as the SPEC-2 "cursor in child" reconciliation + the SPEC-1 §7.3 "role-per-phase" flag for SPEC-4).

---

## 13. Done bar / success criteria (v0.3)

- ✅ A profile with `backend: claude` spawns a real `claude -p` child via the CC factory; the engine routes by `agentDef.backend` through the `BackendRegistry`; the run appears in armory-todo + `/fleet` Fleet view like any Pi run.
- ✅ Memory hydration works in CC: the 3-scope block is baked into `--append-system-prompt`; the same `MemoryHydratePort` the Pi factory uses feeds the CC factory.
- ✅ `todo` is excluded in CC: `--disallowed-tools`/`--allowed-tools` when supported, prompt-nudge fallback otherwise; chip `t✓`.
- ✅ Vision in CC is pass-through-only (`v~`); the gap is **declared** in `Backend.hookParity` and **visible** in the Backends view + Agents chip — never a spawn-time surprise.
- ✅ `session_key` resume works in both backends: re-spawn a profile → resumes its prior session natively (`SessionManager.resume` / `--resume <id>`); stale-id fallback to a fresh run surfaces a visible warning.
- ✅ `backend` + `sessionKey` frontmatter fields parse + validate (invalid `backend` → actionable `FrontmatterError`).
- ✅ The `/fleet` Backends view renders `registry.list()` with availability/version/schema/chip; `r:Refresh` re-detects; `i:Info` shows the flag-support matrix + hook mechanism notes.
- ✅ `claude` absent or schema-drifted → backend `available:false`; `backend:claude` profiles fail fast at spawn with the actionable error.
- ✅ Day-one dual-arsenal: `general-purpose` (pi) + `general-purpose-cc` (claude) builtins; fanning out one task across both is the parent calling `subagent` twice.
- ✅ `pnpm typecheck` + `pnpm test:run` green; the real-CC smoke (`scripts/spec-3-smoke.mts`, runnable only when `claude` is installed — NOT in CI) passes.

**Competitive dimension (PRD §8 SPEC-3):** Dual-arsenal — only kky42 attempts, weakly. Fleet ships it with a visible, honest hook-parity contract + native resume in both backends.

---

## 14. Decision log (brainstorm)

| Q | Decision | Rationale |
|---|---|---|
| Q1 (moat parity in CC) | **B — graceful degradation.** Memory baked into prompt (achievable); `todo` excluded via `--disallowed-tools`/prompt-nudge (achievable); vision pass-through-only with the `v~` gap **declared** in the per-backend armory chip. | Keeps the moat's *intent* in CC where the mechanism exists; honestly records the one real gap (no `customTools` → no `describe_image` fallback); the chip makes the contract visible (SPEC-1 §7.2 "moat as visible contract"). A over-engineers against a CLI we don't control; C undersells what's achievable. |
| Q2 (routing model) | **A — profile pins `backend`.** Fan-out = two profiles (`foo-pi.md` + `foo-cc.md`); no `backend` tool param; engine unchanged. | Literal PRD glossary reading ("profile = backend + model + thinking + tools + role prompt"); chip is a **static file property** (no spawn-time inference → no silent `v~` degradation); simplest engine; dual-arsenal visible at rest in the registry. Drift cost is small and a feature (explicit). |
| Q3 (`session_key` resume) | **A — backend-native resume.** `sessionKey` per profile (default = name); each backend resumes its own prior session (`SessionManager.resume` / `--resume <id>`); `backendSessionId` on the run record. | Only sensible reading of "across backends" — a session hopping Pi→CC needs a shared transcript format neither backend produces (SPEC-6+ research, not a real use case). Both backends have native resume primitives. C would drop a named PRD §8 deliverable. |
| Q4 (CC execution mode) | **A — streaming (`--output-format stream-json`).** Version-detect at adapter construction; fail-loud at the backend. | The `ChildSession` interface is event-based by design; one-shot violates `subscribe`/`abort`/turn-budget. `session_id` (for Q3=A resume) comes from the stream-json init event. Version-detect (not silent runtime fallback) is the PRD §9 mitigation — fail-loud at the backend, degrade-soft at the hook level (Q1=B), never silently. |
| Q5 (abstraction shape) | **B — `ChildSessionFactory` (unchanged) + `BackendRegistry` + `Backend` descriptor.** No `BackendPort` interface. | `ChildSessionFactory` is already the creation seam (SPEC-1 got it right); the registry is the natural home for the metadata Q1/Q4 need (hook-parity, version, availability). YAGNI against A's port + adapters for one extra backend; a third backend is a drop-in descriptor (no refactor). C bifurcates the engine + duplicates wiring. |
| (frontmatter shape) | `backend` + `sessionKey` are named fields with sensible defaults — consistent with `todoSync`/`memoryHydrate`/`vision`. Per-spawn `backend` override is the SPEC-6 power-knob. | SPEC-1 §7.2 pattern: the moat/routing as a visible, toggleable contract. |
| (PRD `.pi/subagents/` wording) | Reconciled → profiles stay in `.pi/agents/` (+ global + builtins); `backend` is a frontmatter field on the same files. | Same flavor as SPEC-2's "cursor in child" reconciliation + SPEC-1 §7.3's "role-per-phase" flag for SPEC-4. |
| (Pi factory SessionManager) | Switch `inMemory()` → file-backed so Pi-side resume works. The only SPEC-2 module SPEC-3 touches; one contained line. | Resume requires a session id that survives across spawns; inMemory can't. No behavior change for non-resume runs. |

---

## 15. References

- Master PRD: [`../PRD.md`](../PRD.md) §4 (engine strategy), §8 (SPEC-3 scope), §9 (CC backend coupling risk), §10 (glossary: profile)
- SPEC-1 spec: [`./SPEC-1-core-engine-todo-sync.md`](./SPEC-1-core-engine-todo-sync.md) §5 (spawn lifecycle), §7.2 (frontmatter + deferred `backend` field), §9 (guards), §12 (deferrals)
- SPEC-2 spec: [`./SPEC-2-deep-armory-integration.md`](./SPEC-2-deep-armory-integration.md) §2 (CustomResourceLoader), §4 (memory port), §5 (vision port), §9 (guards), §12 (deferrals)
- Sibling ecosystem: [armory-todo](https://github.com/getpipher/armory-todo), [armory-memory](https://github.com/getpipher/armory-memory), [vision](https://github.com/getpipher/vision), [cursor](https://github.com/getpipher/cursor) (cursor integration deferred to SPEC-5b)
- pi extension API: `…/pi-coding-agent/docs/extensions.md` (Custom Tools, Events, Custom UI)
- pi SDK: `…/pi-coding-agent/docs/sdk.md` (`createAgentSession`, `SessionManager`, `ResourceLoader`)
- getpipher conventions + UX mental model + EditorTheme gotcha: [`../../getpipher/AGENTS.md`](../../getpipher/AGENTS.md)
- Claude Code CLI: `claude -p --help` (stream-json schema, `--resume`, `--disallowed-tools`, `--max-turns` — Anthropic-controlled; version-detect mitigates)