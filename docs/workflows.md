# Fleet workflows — the JS DSL API

> **Status:** v0.12.x. Workflows are authored in a small JS DSL (`src/workflows/source.ts` parses; `src/workflows/vm-realm.ts` evaluates). Every run is journaled + resumable; `edit-resume` replays the unchanged prefix from cache and re-runs only the edited suffix.
>
> This is the reference the orchestrator (you, or a model calling `fleet action: workflow`) reads to write a workflow script **on the first try** — instead of guess-and-check (the #38 friction).

A workflow script is a JS string you pass to `fleet action: workflow` (`script` param) or save + run by `name`. It runs in a sandboxed `vm` realm that injects **5 orchestration globals**, **7 helpers**, and a few **realm globals**. The script's last expression (or `module.exports`) is the workflow result.

---

## 1. The required `export const meta`

Every script **must** begin with a `meta` declaration (parsed before the body runs; a missing/malformed one fails fast with `…: missing \`export const meta = {…}\``):

```js
export const meta = {
  name: "my-workflow",
  description: "One line: what this workflow does.",
  phases: [{ title: "Plan" }, { title: "Execute" }],
};
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string | Non-empty. The save-as + display name. |
| `description` | ✅ | string | One-line summary. |
| `phases` | optional | `Array<{ title: string }>` | Declared phase titles (drives the progress view + per-phase counts). `phase(title)` calls should match these titles. |

Only `name`/`description`/`phases` are recognized; other fields are ignored. The body is everything after the closing brace of `meta`.

---

## 2. `agent(prompt, opts?)` — spawn a child subagent

The atomic unit. Spawns a named armory-native child via the fleet's spawn path (per-workflow concurrency pool + a fresh lock per spawn — **not** the foreground single-slot lock), journals the call + result by positional index, and returns the agent's final text.

```js
const plan = await agent("Outline a TDD plan for the parser.", { tier: "economy" });
```

**Returns:** the child's final text (string) on success; `null` on a failed spawn (the workflow does **not** abort on a spawn failure — you get `null` and can branch on it). When `opts.schema` is set, the returned string is `JSON.parse`d into the validated shape (or left as a string if it isn't JSON).

**`opts`** (all optional):

| Field | Type | Meaning |
|---|---|---|
| `agentType` | string | Agent name from the registry (default `"general-purpose"`). |
| `model` | string | Model override, e.g. `"Ollama/minimax-m3:cloud"`. |
| `tier` | string | Cost-tier name (routes the model): the built-in tiers are `"economy"`/`"standard"`/`"frontier"` (see the Tiers view; overridable via global/project tiers.json). |
| `skills` | string[] | Skills to load for this child (opt-in; default loads none — #32 lean substrate). |
| `backend` | `"pi"` \| `"claude"` | Backend override (cross-harness; default = the agent's). |
| `label` | string | Display label for the call (default `agent N`); shown in the Runs view. |
| `phase` | string | Phase this call belongs to (default = the current `phase()`). |
| `timeoutMs` | number | Per-spawn timeout; on timeout the spawn is retried (if `retries` remain) or returns a failed result. |
| `retries` | number | Retries on a failed spawn status (default `0`; also driven by `fleet`'s `agentRetries`). |
| `schema` | object | JSON-schema for the expected result; a mismatch triggers a one-shot repair re-spawn. |
| `isolation` | `"worktree"` | Run in an isolated git worktree (fails fast in a non-git cwd). |
| `lifecycle` | string | Run a full superpowers lifecycle (e.g. `"default"`) as this one step (the moat). |

**Resume:** on `edit-resume`, a call is replayed from cache when its `prompt` + `opts` match the prior run's call at the same positional index — so you can edit the script's *suffix* without re-running the *prefix*.

---

## 3. Orchestration globals

### `parallel(thunks)` — concurrency-clamped, order-preserving

Runs the thunks up to the workflow's `concurrency` at a time (default 3; set via `fleet`'s `concurrency` param, clamped `[1, 16]`). Results come back in the **same order** as the thunks.

```js
const reviews = await parallel(angles.map((a) => () => agent(`Review for ${a} issues.`, { tier: "standard" })));
// reviews[i] is the result of thunks[i] (null if that spawn failed)
```

> **Failure model:** a thunk that *returns* `null` (a failed spawn) does **not** abort `parallel` — that slot is `null`. A thunk that *throws* (an explicit `throw`, or a signal abort) rejects `Promise.all` → the workflow aborts with the throw's message (surfaced by `workflow_control status` — #37).

### `pipeline(items, ...stages)` — fan items through sequential stages

Each stage is applied to every item; `Promise.all` per stage (so a stage runs concurrently across items up to the workflow's concurrency).

```js
const out = await pipeline(topics, findSources, summarize, dedupe);
```

### `phase(title, opts?)` — declare/enter a phase

Marks the current phase for subsequent `agent()` calls (drives the progress view + per-phase accounting). `title` should match a `meta.phases[].title`. `opts.budget` (number) optionally caps the token budget for the phase.

```js
phase("Execute");
await agent("Implement step 1.");
```

### `workflow(name, args?)` — run a saved workflow as a child

Recurses into another saved workflow (recursion-capped). An aborted child throws `child workflow '<name>' aborted: <reason>` → the parent aborts with that reason.

---

## 4. The 7 helpers

| Helper | Signature | Purpose |
|---|---|---|
| `verify(item, opts?)` | `opts: { reviewers?, threshold?, lens?, tier?, model?, skills?, backend?, retries?, timeoutMs? }` | Multi-reviewer vote on `item`; passes when the real-vote fraction ≥ `threshold` (default 0.5). |
| `judgePanel(attempts, opts?)` | `attempts: unknown[]` | A judge panel scores the attempts and returns `{ index, score, judgments }`. |
| `loopUntilDry(opts)` | `opts: { round: (n) => results[] \| [], consecutiveEmpty?, maxRounds? }` | Discovery loop: calls `round(n)` until `consecutiveEmpty` (default 2) empty rounds or `maxRounds` (default 50). |
| `completenessCheck(taskArgs, results)` | — | Checks `results` cover the `taskArgs` surface (gated completeness; returns the gap report). |
| `gate(thunk, validator, opts?)` | `opts: { attempts? }` | Re-runs `thunk(feedback, attempt)` until `validator(value)` returns `{ ok: true }` (default 3 attempts). |
| `retry(thunk, opts?)` | `opts: { attempts?, until? }` | Retries `thunk(attempt)` up to `attempts` (default 3) or until `until(result)` is true. |
| `checkpoint(prompt, opts?)` | `opts: { kind?, choices?, default?, headless?, timeoutMs? }` | Interactive checkpoint (confirm/input/select). Headless: returns `default` or aborts. |

Helpers are journaled as `helper:call`/`helper:result` by index (same resume semantics as `agent()`).

---

## 5. The script context (realm globals)

| Global | Type | Meaning |
|---|---|---|
| `args` | unknown | The `args` passed when the workflow was started (`fleet`'s `args` param / a parent `workflow(name, args)` call). |
| `cwd` | string | The session cwd (the workflow runs in-place; `agent({ isolation: "worktree" })` for isolation). |
| `process.cwd()` | — | Returns `cwd` (deterministic). **`process.env` is NOT exposed.** |
| `budget` | `{ total, spent(), remaining() }` | The token budget for this run. `remaining()` returns a number (doesn't throw); the next `agent()` call throws `token budget exceeded` when `remaining() <= 0`. |
| `log(msg)` | — | Appends to the run log (not stdout); visible in the Runs view. |

**Stripped (determinism, not security — PRD §6 trusted-dev-environment):** `Date`, `Math` (whole), `setTimeout`/`setInterval`/`setImmediate` (+ clear variants), `eval`, `Function`, `globalThis`, `fetch`, `require` (so no `fs`/`net` reachable). `import` is a syntax error in the JS-only realm (the script is CommonJS-wrapped). The realm is JS-only (no `.ts` → no transpile). `console.*` aliases to `log()` (accidental `console.log` works). The body can use `module.exports` (CommonJS) or rely on the last expression; `export const meta` is the parse-time declaration (extracted by `source.ts` before the body runs, not a vm CommonJS export).

---

## 6. Worked examples

### Minimal parallel (independent tasks)

```js
export const meta = {
  name: "tri-review",
  description: "Three review angles in parallel.",
  phases: [{ title: "Review" }],
};

phase("Review");
const angles = ["security", "correctness", "performance"];
const reviews = await parallel(angles.map((a) => () => agent(`Review the diff for ${a} issues. Report concrete findings.`, { tier: "standard" })));
return reviews; // array of strings (or null where a spawn failed)
```

### Minimal sequential (gated)

```js
export const meta = {
  name: "plan-then-build",
  description: "Plan, verify the plan, then execute.",
  phases: [{ title: "Plan" }, { title: "Execute" }],
};

phase("Plan");
const plan = await agent("Produce a JSON plan.", { tier: "economy", schema: { type: "object" } });
await verify(plan, { reviewers: 2, lens: "is the plan complete" });

phase("Execute");
return await gate(
  (feedback) => agent(feedback ? `Revise: ${feedback}` : "Execute the plan.", { tier: "standard" }),
  (result) => ({ ok: !!result && String(result).length > 50, feedback: "output too short" }),
);
```

---

## 7. The error surface (what the orchestrator sees)

| Failure | Workflow result | `workflow_control status` text |
|---|---|---|
| Script `throw` (budget/timeout/signal) | `aborted`, `error` = the throw message | `workflow wf-x: aborted — <message>` (#37 surfaces the reason) |
| `agent()` spawn fails (returns `null`) | `completed` (the slot is `null`) | `workflow wf-x: completed` — branch on `null` in the script |
| `parallel()` thunk throws | `aborted`, `error` = the thunk's throw | `workflow wf-x: aborted — <message>` |
| Child `workflow()` aborts | `aborted`, `error` = `child workflow '<name>' aborted: <reason>` | surfaced |
| `token budget exceeded` | `aborted`, `error` = `token budget exceeded` | surfaced |

`details.run.error` always carries the full reason; the headline text is capped at 300 chars (`…(truncated from N chars, see details.run.error)`).

---

## See also

- **5 builtin workflows** in `src/workflows/builtin/` (`adversarial-review`, `code-review`, `codebase-audit`, `deep-research`, `multi-perspective`) — read them as larger worked examples.
- The `fleet` tool's `concurrency`/`agentRetries`/`agentTimeoutMs`/`tokenBudget` params configure the run (see the tool's param descriptions).
- Resume/journal mechanics: `src/workflows/journal.ts` + `runtime/controller.ts`.