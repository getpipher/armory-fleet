# SPEC-3 smoke checklist (real-pi, term-driven)

Rows that need no `claude` call are run via `term` inside a real pi session; rows 2-4 are the script.

## How to run
- Script (rows 2-4): `node --import tsx scripts/spec-3-smoke.mts` (skips CC rows if claude absent)
- Term rows (1/5/6/7): spawn pi in `~/local-dev/getpipher/armory-fleet`, drive via `term`

## Rows
| # | Action | Expected |
|---|---|---|
| 1 | extension loads with `claude` absent | `/fleet` Backends view shows `claude: ✗ (not installed)`; `pi: ✓` |
| 2 | `subagent(general-purpose, "reply OK")` (pi) | run completes; armory chip `t✓ m✓ v✓` |
| 3 | `subagent(general-purpose-cc, "reply OK")` (claude, if available) | run completes via `claude -p`; `backendSessionId` set; chip `t✓ m✓ v~` |
| 4 | re-spawn `general-purpose-cc` same `sessionKey` | `--resume <id>` passed; CC replays history |
| 5 | `backend: invalid` profile in `.pi/agents/` | load warning surfaced; profile excluded from registry |
| 6 | `claude` schema drift (point FLEET_CLAUDE_BIN at a fake) | Backends view shows `schema ✗`; spawn fails fast with actionable error |
| 7 | Backends view `r:Refresh` + `i:Info` | refresh notifies "restart pi to re-detect"; info shows flag matrix + hook mechanism notes |

## How to inspect the CC invocation
- The `i:Info` pane on the `claude` backend row shows the flag-support matrix probed at init.
- Set `DEBUG=fleet:cc` (or equivalent) to log the composed `claude -p` args + the NDJSON events received.

## Pass bar
- Rows 1, 5, 6, 7 pass (term-driven, no CC call).
- Rows 2-4 pass when `claude` is installed; skipped (exit 0) otherwise.