# SPEC-5a — term-driven TUI smoke checklist

> Run after installing `@getpipher/armory-fleet@0.5.0` into pi (`~/.pi/agent/settings.json` packages), `/reload` pi.

## Setup
- [ ] `~/.pi/agent/settings.json` `packages` includes `npm:@getpipher/armory-fleet@0.5.0` (+ `armory-todo@0.5.4`).
- [ ] `/reload` pi — `[Extensions]` shows `@getpipher/armory-fleet@0.5.0:src` with no load error.
- [ ] Ollama key present in `~/.pi/agent/auth.json` (pi loads automatically — no env var).
- [ ] (Optional) RECTOR re-auths `claude` first to exercise a per-phase `backend: claude` scheduled lifecycle.

## `/fleet` panel — scheduled tab
- [ ] `/fleet` opens → tabs render: `fleet · lifecycle · agents · backends · scheduled`.
- [ ] `tab` to `scheduled` → empty list renders + footer `a:Add  p:Pause/resume  d:Delete  i:Info  tab:Fleet  q:Quit`.
- [ ] `a:Add` → inline Input: `task>` → type a trivial task → enter → `schedule (cron | interval | one-shot ISO)>` → type `5s` → enter → `lifecycle (blank=default)>` → enter → row appears with `▶ 5s default "…" next: <iso> sch-…`.
- [ ] `i:Info` on the row → schedule detail pane (id, expression, lifecycle, task, paused, nextFire) + `esc:Back`.
- [ ] `p:Pause/resume` on the row → row toggles to `⏸` + `paused`; `p` again → back to `▶`.
- [ ] `d:Delete` on the row → row removed.

## `/fleet` panel — fleet tab bg row status
- [ ] Wait for the `5s` schedule to fire (if not deleted) → a bg run row appears in the `fleet` tab with `▶` + `●<phase> n/5` + `checkpointed` + `pi`.
- [ ] `i:Info` on the bg row → phase timeline (reads the journal).
- [ ] On completion → row becomes `✓` + branch `fleet/fl-…`; `fleet_results()` returns it; a pi notify fires "fleet run … completed".

## `/fleet-schedule` slash
- [ ] `/fleet-schedule <task> 30m --lifecycle default` → prints `scheduled: sch-… · next fire: <iso>`.

## `subagent` tool (agent path)
- [ ] The agent calls `subagent({ agent, task, background: true, lifecycle: "default" })` → returns `{ runId, status: "background" }` immediately (no await).
- [ ] The agent calls `subagent({ agent, task, schedule: "1h" })` → returns `{ scheduleId, nextFire }`.
- [ ] `background + schedule` together → actionable error.
- [ ] `fleet_results({})` → returns ready completed-run summaries; pulling marks delivered.

## Resume
- [ ] Kill pi mid-lifecycle (Ctrl+C while a bg run is at `▶ implement 3/5`).
- [ ] Reopen pi in the same project → notify "1 interrupted fleet run — open /fleet to resume".
- [ ] `/fleet` → `lifecycle` tab shows the interrupted run; the journal under `.pi/fleet/runs/` has no terminal event.

## PID-lock
- [ ] Open a second pi session in the same project → schedules don't double-fire (the second session defers; `.pi/fleet/schedules.lock` holds the first session's PID).

## Manual end-to-end (optional, real Ollama)
- [ ] `node --import tsx scripts/spec-5a-smoke.mts` → `SMOKE PASSED ✅` (worktree created, lifecycle ran, journal recorded, inbox received, one-shot schedule fired once + auto-deleted). Safe to run from the repo cwd — the worktree is the isolation.

## Guards
- [ ] Invalid cron expression at `a:Add` → actionable error (resolve-time, not fire-time).
- [ ] `background` runs cap at `fleet.maxConcurrentBg` (default 3); a 4th bg run queues (`⏳` in fleet tab).