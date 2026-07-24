# SPEC-1 integration smoke (real pi)

Run inside a real pi session with armory-fleet loaded. Cheapest first check:
`pi -e ./src/index.ts` from the repo root (the extension imports
`@getpipher/armory-todo` + the pi SDK from `node_modules/`).

## Load + panel render (no model call, no cost)

- [ ] `pi -e ./src/index.ts` starts without an uncaughtException (extension
      loads: ModelRuntime.create, registry discovery, tool + command register).
- [ ] The `subagent` tool is listed in available tools.
- [ ] `/fleet` opens the panel; two tabs (`[Fleet]  Agents`) render with no
      `theme.getFgAnsi is not a function` crash (the EditorTheme-gotcha lesson).
- [ ] Agents view lists `general-purpose  [builtin]  (default)  todoSync:✓`.
- [ ] `tab` switches views; `q`/`esc` closes the panel back to the prompt.
- [ ] Switch pi themes (`/theme` or cycle) — the panel still renders.

## Subagent run (real model call — uses your API keys + budget)

- [ ] From the Agents view: select `general-purpose`, press `r`, type
      "list files in cwd", Enter, blank link, Enter → a run appears in Fleet
      as `▶ running`, then `✓ completed`.
- [ ] `/todo` shows a `fleet`-project task for that run (in_progress → done).
- [ ] Model path: ask the model "delegate a quick file listing to a subagent"
      → it calls `subagent`; the run appears in `/fleet` + armory-todo.
- [ ] Linking: with an existing open todo id, call
      `subagent({agent, task, todoId})` → the todo goes in_progress, and on
      completion restores to open + a result note.
- [ ] Esc mid-run aborts the child; the row flips to `✗ aborted`; a created
      `fleet` task reverts to `open`.
- [ ] Turn budget: a looping agent hits 20 turns → `failed` with "hit turn
      budget (20)…"; created `fleet` task reverts to `open`.
- [ ] Concurrency=1: trigger two `subagent` calls in one turn → second returns
      isError naming the running runId.
- [ ] `todo` is never callable by a child (fleet is the single writer).
- [ ] Non-TUI (`pi -p "delegate listing to subagent"`): panel skipped, tool works.

## Release (co-release with armory-todo — DEFERRED to RECTOR)

1. Tag + push `armory-todo v0.5.4` (exports map + `src/index.d.ts`, already
   merged on main) → triggers armory-todo `release.yml` → npm publish.
2. Once `0.5.4` is on npm: in armory-fleet `package.json`, switch
   `"@getpipher/armory-todo": "file:../armory-todo"` → `"^0.5.4"`,
   set `"private": false`, bump `"version": "0.1.0"`, `pnpm install` (refresh
   lockfile), `pnpm typecheck && pnpm test:run`.
3. Commit, tag `v0.1.0`, push → triggers armory-fleet `release.yml`
   → npm publish + GitHub Release.