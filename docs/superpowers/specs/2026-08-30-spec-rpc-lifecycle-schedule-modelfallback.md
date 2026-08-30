# SPEC — RPC spawn `lifecycle`/`modelFallback` params + `schedule` verb (#83)

**Date:** 2026-08-30 · **Status:** approved (Option B, RECTOR) · **Parent:** SPEC-6-4 §7 deferred list
**Frozen-surface rule:** additive only — no renames, no reshapes, no new error codes.

## Problem

SPEC-6-4 shipped RPC `spawn` as single-delegate + background routing only. `lifecycle`, `schedule`, and `modelFallback` reject with `E-BAD-PARAMS`. The `subagent` tool supports all three; the RPC surface should reach parity for external consumers.

## Decisions

**D1 — `schedule` is its own verb (RECTOR, Option B).** Not a spawn param. Reasons: the scheduler is lifecycle-based (`ScheduleSpec` = `{ task, expression, lifecycle?, auto?, isolation?, cwd? }` — no `agent` field), so a spawn param would advertise an affordance that doesn't exist; and spawn's reply shape must stay uniform (`{ runId }`) rather than branching on params.

**D2 — spawn `lifecycle` param mirrors the tool's routing:**
- `background: true` (+ optional `lifecycle`): `runBackground({ lifecycle: params.lifecycle ?? "default" })` — replaces today's hardcoded `"default"`.
- `lifecycle` WITHOUT `background`: detached foreground-semantics lifecycle run — `runLifecycle(task, lifecycle, { deps: lifecycleFullDeps, mode: "auto", entryCwd })` with `genRunId: () => runId` (the asyncRunLifecycle pre-minted-id pattern), phase spawn on the SESSION `deps.lock` (foreground pool, like the tool's fg lifecycle), phase cwd resolution unchanged (`lifecycle.cwd ?? entryCwd`).
- `mode` is always `"auto"` over RPC (the tool hardcodes it too; checkpointed lifecycles are interactive-only).

**D3 — `modelFallback` (per-request wins over the global default, exactly like the tool's `params.modelFallback ?? deps.defaultModelFallback`):**
- bg leg: `RunBackgroundOpts.modelFallback` → `RunLifecycleOpts.modelFallback` → `asyncRunLifecycle`'s `withModelFallbackRetry(fn, opts.modelFallback ?? deps.defaultModelFallback)`.
- fg single-delegate leg: retry ONCE inline, mirroring the tool's direct path — fresh runId for the retry (the primary already journaled under the pre-minted id; reusing it would double-emit `run:started`), `todoId` relinked from the primary. Extracted as `retryForegroundOnce(primary, fallback, spawn)` (testable).
- fg lifecycle leg: `withModelFallbackRetry` on the phase spawn (same as the tool + asyncRunLifecycle).

**D4 — schedule verb contract:**
- Request: `{ id, verb: "schedule", params: { task, expression, lifecycle?, auto?, isolation?, cwd? } }`.
- Reply: `{ ok: true, data: { scheduleId, nextFire: <ISO string | null> } }`.
- Behind the same `ARMORY_FLEET_RPC_CONTROL` gate (it is a control operation). Scheduler not configured → `E-BAD-PARAMS` (actionable "scheduler missing" message, mirroring the bg message style). `scheduler.register` throws (invalid expression) → `E-BAD-PARAMS` with the parser's message.
- No new verbs for pause/list/abort of schedules — out of scope (#83 tracks registration only).
- No run events at registration (nothing is running); on fire, the existing scheduler → `runBackground` path emits the normal `fleet:*` stream with `mode: "scheduled"` (pre-existing SPEC-5a behavior).

**D5 — validation:** `lifecycle`/`modelFallback`/`expression`/`task` must be non-empty strings when set; `auto` boolean; `isolation` enum (`'worktree' | 'none' | 'auto'`); `cwd` resolves through the same `resolveDispatchCwd` preflight as spawn. All failures → `E-BAD-PARAMS`, validation BEFORE runId minting (no ghost runIds).

## Non-goals

Per-dispatch `thinkingLevel` tool param (follow-up to #78); schedule pause/list/abort verbs; `agent` on `ScheduleSpec`; external transports (SPEC-6-4 §7).
