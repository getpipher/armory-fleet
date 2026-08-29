# SPEC-6-4 Event-Bus RPC + Live Conversation Viewer Design

**Date:** 2026-08-29
**Status:** Approved design (brainstorm complete); implementation not started
**Target:** `@getpipher/armory-fleet@1.0.0` (the last roadmap item before v1.0)
**Branch:** `feat/spec-6-4-event-bus-rpc` (to be created)
**PRD:** §8 SPEC-6 — "event-bus + cross-extension RPC (other extensions spawn/steer/observe subagents)"
**Splits from:** [#20](https://github.com/getpipher/armory-fleet/issues/20) (CLOSED — its cwd-isolation halves shipped as SPEC-6-5 v0.13.0 and #62 v0.16.0). SPEC-6-4 retains the coordination half: event-bus RPC + live conversation viewer. Tracking issue: file at implementation start.

## 1. Purpose

armory-fleet today is a closed world: run state lives in internal stores (`RunRegistry`, `RunLog`, `RunJournal`, bg-runs, workflow store), consumed only by the fleet panel and widget in the same process. No `pi.events` are emitted (the cross-extension bus pi documents at `pi.events.on`/`emit` is unused), so a sibling extension — or any future tooling — cannot spawn, steer, observe, or abort fleet runs programmatically. The PRD's moat claim for v1.0 is *composability: other extensions build on armory-fleet*; that requires a public surface. This SPEC is that surface.

Second gap: the Runs-tab conversation viewer (SPEC-5b-1 timeline, 5b-3 full-message overlay) renders from the persistent journal **after** a run finishes. There is no way to watch a run's conversation as it happens. SPEC-5b's original "conversation viewer (live-scrolling overlay)" is completed here.

**Out of scope (deferred, designed-for):** external-process transport (stdio/HTTP/CLI bridge), a `@getpipher/fleet-client` npm helper package, widget conversation tail, public in-flight `tool_start` events, steer streaming (ack-only steering). See §7.

## 2. Locked decisions (from the brainstorm)

| # | Area | Decision | Alternatives rejected |
|---|---|---|---|
| 1 | **Consumers / transport** | **In-process `pi.events` only** for v1.0. Taxonomy + verb shapes are transport-agnostic (envelope + frozen error codes), so a later external bridge is a new transport front-end, not a redesign. | External bridge now — no concrete consumer; security surface without a user. Global API object — module-instance split-brain risk, compile-time coupling, zero cross-process path. |
| 2 | **Verb surface** | **Full set**: `spawn` / `steer` / `observe` / `abort` / `status`. | Minimal trio (spawn/observe/abort) — under-freezes; consumers would need a v2 for reads. Read-half-first — no consumer story until write half lands. |
| 3 | **Event granularity** | **Two-tier public stream**: coarse = lifecycle (`fleet:run:*`, `fleet:phase:*`); fine = excerpted child conversation (`fleet:child:message`, `fleet:child:tool`). Consumers pick a tier. The live viewer is the **first consumer of the fine tier** (dogfooding: the API is proven by our own TUI, not only by mocks). | Lifecycle-only public + private viewer tap — taxonomy break later when conversation events are added. Single firehose — noisy for lifecycle-only consumers. |
| 4 | **Live viewer form** | **Live mode on the existing 5b-3 full-message overlay.** Open on a running run → live-scrolling; open on a finished run → today's replay. Same renderer (`conversation-rows.ts`), same row format; two data sources (persistent `RunLog` for replay, live subscribe for running). Tail-follows at bottom; scrolling up frees follow; returning to bottom re-engages. | Dedicated tab — panel surgery, conversation rows in a SelectList are awkward. Widget tail — competes with editor for space; sliver-only. |
| 5 | **Control gate** | **On by default with a kill-switch.** Mechanism: env `ARMORY_FLEET_RPC_CONTROL` (default on; `0`/`false` disables `spawn`/`steer`/`abort` with `E-CONTROL-DISABLED`). Read-only `observe`/`status` stay ungated. Consistent with the existing `ARMORY_FLEET_*` config surface (#31 concurrency, #58 fallback); migrates to a fleet settings file when that lands (#78 direction). Threat model, honestly: in-process extensions already have full system access via pi itself — the gate guards accidents and raises awareness, not adversaries; README says exactly that. | Off-by-default — friction with no security gain (same-trust-domain). No gate — one less knob, but the switch is ~20 lines and gives users a documented off position. |
| 6 | **Architecture** | **Bus-first, layered** (see §3): `FleetEventBus` (two-tier publisher + per-run ring buffers) + `RpcServer` (correlation-ID dispatch over one request channel). Viewer consumes internal sources; RPC consumers consume broadcasts. | Global API singleton (split-brain across module instances). Journal-tail/poll (violates true-live decisions; steer/abort need a live path anyway). |

## 3. Architecture

### 3.1 Event taxonomy (broadcast channels — frozen surface)

Every event envelope: `{ runId, seq, ts, ...payload }` — `seq` is a per-run monotonic counter for ordering + dedupe by late joiners.

**Coarse tier — lifecycle:**

| Channel | Payload |
|---|---|
| `fleet:run:started` | `{ agent, model?, cwd?, mode: "foreground"\|"background"\|"scheduled"\|"workflow", task }` |
| `fleet:phase:started` | `{ phase }` |
| `fleet:phase:completed` | `{ phase, summary, paths }` |
| `fleet:phase:failed` | `{ phase, error }` |
| `fleet:run:ended` | `{ status: "completed"\|"failed"\|"aborted", result?, error?, filesTouched?, toolCallCount, durationMs }` |

One terminal event per run, `status` enum covers the journal's separate `run:aborted` (consumers handle one terminal shape). `mode` is captured at `RunRecord` creation — the `subagent` tool path = `foreground`, async-runner = `background`, scheduler fire = `scheduled`, workflow runner = `workflow`.

**Fine tier — child conversation** (journal fidelity rules apply verbatim — same `excerpt()` call sites: args≤200ch, result≤500ch, messages excerpted, errors in full):

| Channel | Payload |
|---|---|
| `fleet:child:message` | `{ role, text }` — one per message end |
| `fleet:child:tool` | `{ toolName, args, result, isError }` — one per **completed** tool call (args+result merged; the #60 start-capture pattern) |

Deliberate: **no public in-flight `tool_start`** — payloads stay bounded, fidelity matches the journal exactly, and the widget already covers "what is running right now" internally. Revisit only on a concrete consumer need.

### 3.2 RPC surface (request/response — frozen surface)

Callers emit `fleet:rpc` `{ id, verb, params }`; fleet replies exactly once on `fleet:rpc:result` `{ id, ok: true, data }` or `{ id, ok: false, error: { code, message } }`. `id` is caller-chosen (UUID/string); correlation is the caller's job.

| Verb | Params | `data` | Gate |
|---|---|---|---|
| `spawn` | mirrors the `subagent` tool input (`agent, task, model?, skills?, cwd?, isolation?, maxTurns?, background?, …`) | `{ runId }` — returned immediately; the run proceeds async | `rpcControl` |
| `status` | `{ runId? }` — omit = list running + recent (capped) | `{ runs: RunSummary[] }` | — |
| `observe` | `{ runId, tier: "lifecycle"\|"child"\|"both" }` | `{ events: Envelope[] }` — one-shot replay dump | — |
| `steer` | `{ runId, message }` | `{ ok: true }` — rides the existing 5b steering queue | `rpcControl` |
| `abort` | `{ runId }` | `{ ok: true }` | `rpcControl` |

Semantics:

- **`spawn` is async-uniform.** Always `{ runId }`, never blocks on the run; the result arrives via `fleet:run:ended`. This differs from the synchronous foreground `subagent` tool and is documented. Foreground RPC spawns still occupy the session-level concurrency pool (`E-LOCKED` on full, tool fail-fast parity); `background: true` bypasses the pool via the existing bg path.
- **`observe` is stateless.** Fleet keeps **no per-consumer subscriptions** — the architecture stays broadcast-only. A running run's replay is served from its ring buffer; a finished run's from `RunLog`. Live tail: the consumer subscribes to the broadcast channels and dedupes by `(runId, seq)` against the replay dump. No subscription state = no leak surface.
- **Error codes (frozen enum):** `E-CONTROL-DISABLED`, `E-RUN-NOT-FOUND`, `E-RUN-FINISHED`, `E-BAD-VERB`, `E-BAD-PARAMS`, `E-LOCKED`.

### 3.3 Modules & data flow

```
RunRegistry ──subscribe()──▶┐
RunJournal ──subscribe()───▶┤ FleetEventBus ──pi.events.emit──▶ fleet:run:* / fleet:phase:*  (coarse)
RunLog ──subscribe()───────▶┘        │
                                     └──▶ ring buffers: Map<runId, FineEvent[]>, cap ~500, freed on run:ended
consumers ──"fleet:rpc"──▶ RpcServer(gate, dispatch, correlation) ──▶ "fleet:rpc:result"
viewer overlay (live mode) ── RunLog.subscribe (internal, no bus round-trip) ──▶ append rows
```

New modules:

- **`src/rpc/event-bus.ts`** — `FleetEventBus`: subscribes to the three stores, publishes both tiers on `pi.events`, maintains ring buffers, serves `observe` replays. Constructed in `session_start` alongside the stores; disposed in `session_shutdown` (unsubscribe + channel cleanup — resource cleanup is non-negotiable).
- **`src/rpc/rpc-server.ts`** — `RpcServer`: listens on `fleet:rpc`, validates params, enforces the gate, dispatches to pure verb handlers (injected stores), replies. No fleet state of its own beyond the correlation map.
- **Store change:** `RunLog.subscribe()` and `RunJournal.subscribe()` added — the established store pattern (`RunRegistry.subscribe`, bg-runs, workflow store already do this for the panel). Fine tier = `RunLog.append` fan-out; coarse phase events = `RunJournal.append` fan-out; run-level events = `RunRegistry` mutations.

**Store symmetry = parity by construction:** the viewer, the ring buffer, and `RunLog`-backed replay all derive from the same append calls with the same `excerpt()` — the public fine tier and the TUI cannot diverge (the #75 mock-vs-real lesson, designed away).

### 3.4 Live overlay (viewer)

- Opening the 5b-3 full-message overlay on a **running** run enters live mode: hydrate from `RunLog` (already-flushed events), then subscribe to `RunLog.subscribe` filtered by `runId` and append rows as they land. Internal consumption — no `pi.events` serialization for our own UI — but the appended shapes are the public `fleet:child:*` shapes.
- Tail-follow while the viewport is at the bottom; scrolling up suspends follow; returning to the bottom re-engages.
- Opening on a **finished** run keeps today's replay behavior unchanged. One renderer, one row format, two data sources.
- No new keybinding: the same replay-open action on a running run opens the overlay in live mode (mode decided by run state, not by the user). The Runs-tab row may render a small live indicator; if it does, it derives from the same run-state check — no second source of truth.

## 4. Error handling

- **Exactly one reply per request.** Malformed request (missing `id`/`verb`) → dropped, counted in an internal debug counter (no reply possible without `id`). Unknown verb → `E-BAD-VERB`. Param validation failure → `E-BAD-PARAMS` with the field named. Handler exceptions are caught at the dispatch boundary → `ok:false` — **handler errors never cross the bus**.
- **Bus emits are try/catch-wrapped** — a throwing listener in another extension can never break a fleet run.
- `steer`/`abort` on a finished run → `E-RUN-FINISHED` (no resurrection, no double-abort crash). `spawn` with a full foreground pool → `E-LOCKED` unless `background: true`. Gate disabled → `E-CONTROL-DISABLED` with a message pointing at `ARMORY_FLEET_RPC_CONTROL`.
- **No zombie events:** post-`run:ended` child events are guarded (state check) — the terminal event is last on both tiers for its run.

## 5. Testing

- **Frozen-surface pins:** channel names + envelope/payload shapes asserted verbatim (the §3.1/§3.2 tables become literal expectations) — a breaking taxonomy change must break these tests loudly.
- **Unit:** verb handlers vs mocked stores (pure dispatch); correlation under concurrent requests (unique replies, no cross-talk); gate on/off per verb class; ring buffer cap/eviction/seq monotonicity; `RunLog.subscribe`/`RunJournal.subscribe` ordering + unsubscribe; observe replay parity (running-buffer vs finished-journal → identical shapes); overlay live-append + tail-follow state transitions.
- **Per-backend pin (gotcha #11 class):** a claude `tool_use` line through `mapClaudeEvents` must produce a `fleet:child:tool` fine event — the CLAUDE path is verified explicitly, never assumed from the pi path.
- **Env-independence:** no test asserts configured providers/models (clean CI has none — the #75 lesson).
- **Smoke:** the release-gate smoke gains one real `fleet:rpc` round-trip (`status`) — catches wiring breakage unit mocks structurally cannot.

## 6. Scope

**In:** `src/rpc/event-bus.ts`, `src/rpc/rpc-server.ts`, `RunLog.subscribe` + `RunJournal.subscribe`, ring buffers, overlay live mode, `ARMORY_FLEET_RPC_CONTROL` gate, README section (surface docs + the ~15-line typed client-helper snippet + honest threat-model note), smoke round-trip.

**Out (deferred):** external transport bridge; `@getpipher/fleet-client` package; widget conversation tail; public `tool_start` events; steer streaming; fleet settings file (lands with #78 direction); Runs-tab polish NITs (separate backlog).

## 7. Deferred-work contract

The external bridge, when someone needs it: a transport front-end that speaks `fleet:rpc` requests and re-emits `fleet:*` broadcasts — the taxonomy, verbs, envelopes, and error codes of §3 are already its wire format. No rename, no reshaping; the in-process bus is the reference implementation.
