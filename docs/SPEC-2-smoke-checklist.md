# SPEC-2 smoke checklist (real-pi, term-driven)

> **STATUS (2026-07-24): full-run smoke PASSED — 15/15.** Run via `node --import tsx scripts/spec-2-smoke.mts` (exercises the real factory components + one real `session.prompt()` against Ollama Cloud). Rows 1-5 all green; the integration spawn path (`new ModelRegistry(realRuntime)` + `createAgentSession({customTools, excludeTools, resourceLoader: buildChildLoader})` + `session.prompt()`) is verified end-to-end. The no-cost term smoke (extension loads, /fleet opens, chip + i:Info render) is also verified.

Run inside real pi via the `term` tool. The no-cost parts (extension loads,
`/fleet` opens, Agents-view armory chip renders, `i:Info` detail pane renders)
are verifiable without a model call and catch the EditorTheme-gotcha crash class.

## No-cost smoke (run now, term-driven)

1. Load the armory-fleet extension in real pi (no crash; no `theme.getFgAnsi` crash).
2. Open `/fleet` → panel renders (Fleet + Agents tabs).
3. Switch to Agents → the `general-purpose` row shows `armory:[t✓ m✓ v✓]`.
4. Press `i` on the selected agent → `i:Info` detail pane renders (all hooks,
   model, skills, role prompt); Escape returns to the list.

## Full-run smoke (needs RECTOR's API keys + budget; rows 1–5)

Each row: set up the agent/model, spawn a child via the `subagent` tool or
`/fleet` Run, capture the child's composed system prompt + active tool names,
and assert. Inspect via a throwaway project extension in `.pi/extensions/`
that logs the child's `session_start` system prompt + active tools to a file
the smoke reads back.

| # | Setup | Assert |
|---|---|---|
| 1 | text-only child model, default agent | `describe_image` present; system prompt has 3-scope memory block; `todo` tool absent; **no "Open-TODOs" block leaked**; no host extension hooks fired |
| 2 | multimodal child model, default agent | `describe_image` absent (pass-through); memory block present; `todo` absent |
| 3 | `memoryHydrate: false` agent | no memory block in child prompt |
| 4 | `vision: false` agent, text-only model | no `describe_image` injected |
| 5 | any agent | child prompt contains pi base (tool docs/guidelines/scoped skills) — confirms `systemPromptOverride` composes, not replaces |

## How to inspect the child's prompt + tools

Add a throwaway logging extension at `.pi/extensions/log-child.ts` that hooks
`session_start` / `before_agent_start` and writes the composed system prompt +
`ctx.getActiveTools()` to `/tmp/fleet-smoke-<runId>.log`, then read it back
after the `subagent` call returns. (The throwaway must be project-scoped so it
doesn't leak into other sessions; delete after the smoke.)