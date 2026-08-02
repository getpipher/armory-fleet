# SPEC-6-3 Release-Gate Completion Design

**Date:** 2026-08-02  
**Status:** Approved design; implementation not started  
**Target:** `@getpipher/armory-fleet@0.12.0`  
**Branch:** `feat/spec-6-3-workflows`  
**Parent spec:** [`2026-07-28-spec-6-3-workflows-as-code-design.md`](./2026-07-28-spec-6-3-workflows-as-code-design.md)  
**Triggered by:** Mandatory real-Pi release smoke on PR #21

## 1. Purpose

The first SPEC-6-3 implementation delivered the workflow VM, journal, runner primitives, helpers, registry, row renderer, tool schema, and five builtin scripts. Unit tests, typecheck, CI, 13 task reviews, and a final branch review all passed.

The release smoke then proved that the feature was not integrated as a usable product:

- `/fleet → Workflows` had no definitions or runs;
- all eight Workflows actions were notification-only stubs;
- the model tool exposed controls and options that were not implemented;
- the lifecycle, override, concurrency, progress, and accounting paths were incomplete.

No merge, tag, npm publication, or settings bump occurred. This amendment defines the missing runtime integration required before `v0.12.0` can ship. It supplements the parent spec and supersedes its release-readiness claims where they conflict.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Runtime ownership | One session-scoped `WorkflowController` owns definitions, runs, controls, persistence, and runner adaptation. |
| State | A reactive `WorkflowRunStore`, following the existing `BgRunsStore` pattern, is the sole live panel state source. |
| Workflows view | One combined list contains definitions and active/recent runs as discriminated items. |
| Tool and panel | Both call the same controller API; neither implements orchestration independently. |
| Default dispatch | `background: true`; foreground is explicit with `background: false`. |
| Pause | Cooperative: no new agent/helper dispatch begins; already-running children finish. |
| Stop | Abort the workflow and active children, then journal a terminal abort. |
| Parallelism | A workflow-owned concurrency pool gates all child spawns; the foreground single-slot lock does not serialize workflow children. |
| Accounting | Cost and token totals come from tracked child spawn results, never TODO correlation. |
| Checkpoints | The controller holds the pending resolver; the Workflows view supplies the human response. |
| Release gate | Real-Pi smokes run before merge/tag/publication, not after npm publication. |

## 3. Architecture

### 3.1 `WorkflowController`

Add a session-scoped controller under `src/workflows/runtime/`. It is the only component allowed to start, resume, pause, stop, save, hydrate, or inspect workflow runs.

```ts
interface WorkflowController {
  definitions(): WorkflowDefinition[];
  runs(): WorkflowRunState[];
  getRun(runId: string): WorkflowRunState | undefined;

  start(input: WorkflowStartInput): Promise<WorkflowStartReceipt | WorkflowRunResult>;
  editAndResume(runId: string, script: string): Promise<WorkflowStartReceipt>;
  pause(runId: string): WorkflowRunState;
  resume(runId: string): WorkflowRunState;
  stop(runId: string): Promise<WorkflowRunState>;
  respondToCheckpoint(runId: string, response: unknown): void;

  save(input: WorkflowSaveInput): WorkflowDefinition;
  hydrate(): void;
}
```

The controller depends on explicit ports:

- `WorkflowJournal`;
- `WorkflowRegistry` plus project/global/builtin paths;
- `WorkflowRunStore`;
- `runWorkflow`;
- `WorkflowRunDeps` factory;
- filesystem write/rename operations;
- notification/result-delivery callbacks.

It must not depend directly on panel components or tool schemas.

### 3.2 `WorkflowRunStore`

Add a reactive map with the same guarantees as `BgRunsStore`:

```ts
interface WorkflowRunStore {
  set(runId: string, state: WorkflowRunState): void;
  get(runId: string): WorkflowRunState | undefined;
  values(): WorkflowRunState[];
  subscribe(listener: () => void): () => void;
}
```

Every state mutation emits once. Unsubscribed listeners receive no later events. The panel subscribes while open and disposes the subscription on every close path.

### 3.3 State model

```ts
type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "checkpoint"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

interface WorkflowRunState {
  runId: string;
  name: string;
  script: string;
  args?: unknown;
  status: WorkflowStatus;
  startedAt: number;
  endedAt?: number;
  currentPhase: string;
  phases: Array<{
    title: string;
    agents: number;
    cached: number;
    reRun: number;
  }>;
  childRunIds: string[];
  tokenTotal: number;
  costTotal: number;
  result?: unknown;
  error?: string;
  resumeFromRunId?: string;
  checkpoint?: {
    prompt: string;
    opts: Record<string, unknown>;
  };
}
```

`WorkflowDefinition` retains `name`, `description`, `phases`, `script`, `source`, and `filePath` from the existing registry.

### 3.4 Runner integration hooks

Extend `WorkflowRunDeps` with explicit runtime hooks rather than allowing `index.ts` to infer state from terminal results:

```ts
interface WorkflowRuntimeHooks {
  signal: AbortSignal;
  waitIfPaused(): Promise<void>;
  onProgress(event: WorkflowProgressEvent): void;
}
```

The runner calls `waitIfPaused()` and checks `signal.aborted` before every new agent/helper/child-workflow dispatch. It emits progress for:

- workflow started;
- phase changed;
- child started/completed/failed;
- helper started/completed;
- checkpoint pending/resolved;
- workflow completed/failed/aborted.

A stopped run must not later transition to completed if an in-flight promise resolves.

## 4. Execution semantics

### 4.1 Start and background behavior

`WorkflowStartInput` accepts either:

- `script`; or
- `workflowName`, resolved through project > global > builtin precedence.

Exactly one is required. If `name` is supplied with a script, save it to project scope before dispatch.

`background` defaults to `true`:

- background start returns `{ runId, status: "background" }` immediately;
- foreground start awaits and returns `WorkflowRunResult`;
- both paths create the run row before execution begins;
- background completion updates the store, journals the terminal event, notifies the user, and makes the result available in the Workflows view.

A rejected start leaves no ghost running row. If the journal already contains `runId`, reject the collision.

Background completion also pushes a normalized result into the existing `ResultsInbox` so the parent receives the standard bounded `fleet results ready` hint and can pull it with `fleet_results`. Use the workflow name as `task`, a bounded serialization of the synthesized result as `summary`, and an empty `paths` array unless workflow artifacts are added by a later spec.

### 4.2 Pause, resume, and stop

Control transitions are strict:

| Action | Allowed from | Result |
|---|---|---|
| Pause | queued, running | `paused`; new dispatch waits |
| Resume | paused | `running`; releases waiters |
| Stop | queued, running, paused, checkpoint | `aborted`; abort signal fires; checkpoint waiter is rejected |
| Status-changing action on terminal run | none | actionable error; no mutation |

Pause is cooperative. In-flight children are not killed; new children and helpers do not start until Resume. Stop aborts all children sharing the run signal. Controller methods are idempotent only when repeating the already-achieved state (`pause` on paused, `resume` on running, `stop` on aborted); other invalid transitions throw a specific error naming the run and current state.

### 4.3 Child concurrency

All workflow child spawns—including quality-helper reviewers—pass through one controller-owned `ConcurrencyPool` configured from `concurrency` and clamped to 16.

The adapter must not use the extension's foreground singleton lock as the workflow concurrency mechanism. Each actual `spawnSubagent` invocation receives a child-local lock because the workflow pool already owns admission control. This preserves existing foreground behavior while allowing `parallel()` to execute as specified.

The same tracked spawn wrapper serves direct `agent()` calls and all quality helpers. Helper `agent`, `tier`, and `model` options must reach that wrapper rather than being dropped.

### 4.4 Retry, timeout, and cancellation

Effective child settings use call-level override > run-level default > existing default:

- `retries` > `agentRetries` > `0`;
- `timeoutMs` > `agentTimeoutMs` > unbounded.

Recoverable spawn failures and schema mismatches consume retries. Deterministic environment failures—such as `isolation:"worktree"` in a non-git cwd—fail immediately without retry.

Each child receives a signal combining the workflow abort signal and optional timeout. A timeout produces an actionable failed child result; a workflow Stop produces an aborted workflow, not a timeout or completion.

### 4.5 Lifecycle and overrides

The `WorkflowRunDeps` factory must supply `runLifecycle` using the existing lifecycle adapter. `agent({ lifecycle })` runs a full lifecycle as one step and forwards `worktreePath` when isolated.

The spawn adapter forwards:

- `model`;
- `tier` through a new explicit tier override consumed by `resolveAgentModel`;
- `skills` through `skillsOverride`;
- `backend` through `backendOverride`;
- cancellation signal and timeout;
- child-local concurrency lock.

Model precedence remains call model > call tier > agent tier/model > parent model.

### 4.6 Accounting and child linkage

Wrap the spawn port once inside the runner so every child—including helper reviewers—contributes:

- `childRunIds`;
- `tokenTotal`;
- `costTotal`.

Do not derive workflow totals from TODO IDs or unrelated `RunRegistry` entries. Progress snapshots and terminal journal events persist the accumulated totals. Resume reuses cached results without charging tokens/cost again.

## 5. Journal and recovery

### 5.1 Progress persistence

Add an additive workflow progress event carrying the latest reconstructable snapshot:

```ts
interface WorkflowProgressEvent {
  type: "wf:progress";
  runId: string;
  status: WorkflowStatus;
  currentPhase: string;
  phases: WorkflowRunState["phases"];
  childRunIds: string[];
  tokenTotal: number;
  costTotal: number;
  checkpoint?: WorkflowRunState["checkpoint"];
  ts: number;
}
```

The journal remains append-only and tolerant of a partial final line.

### 5.2 Hydration

On `session_start`, the controller scans workflow journals and reconstructs recent runs:

- terminal journals restore terminal state and result/error;
- non-terminal journals restore `interrupted` state;
- interrupted runs expose Resume and Stop, not Pause;
- restart Resume uses the journaled original script plus `resumeFromRunId`;
- checkpoint response cache behavior remains positional and unchanged.

The Workflows view must show restart candidates, not merely emit a notification.

## 6. Saved-workflow behavior

### 6.1 Validation

Names must match:

```txt
^[a-z][a-z0-9-]{0,63}$
```

Reject path separators, dot traversal, empty names, reserved device names, and scripts without valid exported `meta`. The saved `meta.name` must equal the requested filename/name.

### 6.2 Atomic save and overwrite

Save project workflows to `<cwd>/.pi/fleet/workflows/<name>.js` by writing a sibling temporary file, fsyncing/closing it, and renaming atomically.

- model tool: existing file requires `overwrite:true`;
- panel: existing file opens an explicit confirmation dialog;
- failed validation or write leaves the prior file unchanged;
- successful save refreshes the registry immediately;
- project scope continues to shadow global and builtin definitions.

### 6.3 Canonical source normalization

A saved/builtin source file is not directly executable by `vm.Script`: it contains `export const meta`, and the existing builtin bodies use top-level `await` and `return`. Discovery alone is therefore insufficient.

Add one parser/normalizer used by discovery, save validation, Open/Edit, and execution:

```ts
interface ParsedWorkflowSource {
  meta?: WorkflowMeta;
  source: string;       // complete editable/persisted source
  body: string;         // executable statements after the meta declaration
  executable: string;   // CommonJS async wrapper consumed by vm.Script
}
```

Rules:

1. Saved/builtin files require a literal `export const meta = { ... }` declaration after optional comments/whitespace.
2. Remove exactly the parsed meta declaration span—not arbitrary matching text—from the executable body.
3. Wrap the body as `module.exports = (async () => { ...body... })()` so top-level `await` and `return` are valid.
4. Ephemeral direct scripts may use the canonical body format without metadata.
5. Preserve backward compatibility for explicit `module.exports = ...` scripts by executing them unchanged.
6. Persist and edit the complete `source`; journal and resume the normalized executable form plus the original source required for later editing.
7. Parse/compile errors identify the workflow name/file and occur before a run enters `running`.

All five shipped builtins must execute through this exact parser in an automated integration test; discovery-only tests do not satisfy the release gate.

## 7. Model-callable `fleet` surface

### 7.1 `workflow`

The action accepts:

- `script?`;
- `workflowName?`;
- `name?` and `overwrite?` for Save-as;
- existing args/background/resume/cap fields.

Validation requires exactly one of `script` or `workflowName`. It delegates entirely to `WorkflowController.start()` or `editAndResume()`.

### 7.2 `workflow_control`

`list`, `status`, `pause`, `resume`, and `stop` delegate to the controller:

- `list` returns canonical run IDs, names, states, phases, counts, tokens, and costs;
- `status` returns the complete public run state;
- controls return the updated state;
- no control may return a success-shaped stub.

### 7.3 Keyword authorization

Add a bounded `before_agent_start` hint for `/\bworkflows?\b/i`. The hint authorizes—but does not force—the `fleet.workflow` action. Identifier-like strings do not match. Questions about workflows may still be answered normally; the model decides whether decomposition warrants execution.

## 8. Interactive Workflows view

### 8.1 Combined list

Use discriminated values:

```ts
type WorkflowPanelItem =
  | { kind: "definition"; key: `definition:${string}`; definition: WorkflowDefinition }
  | { kind: "run"; key: `run:${string}`; run: WorkflowRunState };
```

Definitions render first, ordered project > global > builtin and then by name:

```txt
◇ code-review  [builtin]  2 phases  7 parallel review angles plus verification
```

Runs render newest first using live state:

```txt
▶ wf-…  code-review  [running]  Review ▶ Verify ○ · 3 agents · 4.2K tok · $0.03
```

The list must render definitions even when no run exists.

### 8.2 Context-sensitive actions

| Selection | Actions |
|---|---|
| Definition | Run, Open script |
| Running run | Open child, Pause, Stop, Save-as |
| Paused run | Open child, Resume, Stop, Save-as |
| Checkpoint run | Respond, Stop, Open child |
| Interrupted run | Edit-and-resume, Resume unchanged, Stop, Save-as |
| Terminal run | Open child, Edit-and-resume, Save-as, View result |

`Run` opens one inline `Input`:

- blank input runs the selected definition;
- non-empty input closes the panel and asks the parent model to generate and execute a workflow for that prompt through the `fleet` tool.

Multi-line Edit-and-resume closes the custom panel, opens `ctx.ui.editor()` with the original script, submits the edited script to the controller, and reopens the panel. This avoids nesting `ctx.ui.editor()` inside `ctx.ui.custom()`.

Open child switches to the existing Runs conversation viewer using a selected `childRunId`. View result displays the synthesized result with bounded rendering. Save-as uses inline name input plus overwrite confirmation.

### 8.3 Checkpoints

A pending checkpoint row displays its prompt. Confirm checkpoints use Continue/Abort. Input/select checkpoints collect the declared response, call `respondToCheckpoint`, clear pending state, and resume execution. Closing the panel does not silently resolve or orphan the checkpoint; the run remains checkpointed until response or Stop.

## 9. `index.ts` wiring

`index.ts` performs construction only:

1. create journal, registry, run store, and controller per session;
2. build the fully populated runner-deps factory, including lifecycle and override adapters;
3. call `controller.hydrate()`;
4. register the `fleet` tool against the controller;
5. pass controller, store, and registry to `/fleet`;
6. dispose session-scoped subscriptions/active runs on shutdown.

No workflow action handler or control logic belongs directly in `index.ts`.

## 10. Errors and security

All public operations validate inputs and return actionable errors containing the operation and relevant run/name.

Required cases include:

- unknown workflow name with available names;
- malformed or missing script metadata;
- invalid save name or traversal attempt;
- overwrite without permission;
- unknown run ID;
- invalid control transition;
- timeout versus explicit Stop distinction;
- lifecycle unavailable;
- non-git isolation fail-fast;
- duplicate run ID;
- journal/file I/O failure.

`vm` remains a determinism boundary, not a hostile-code security boundary, as documented by the parent spec.

## 11. Testing strategy

All tests live in `test/*.test.mts` and are included by `pnpm test:run`.

### 11.1 Unit tests

- `WorkflowRunStore`: set/get/values/subscribe/unsubscribe.
- controller start: script and definition-by-name; background and foreground; background completion reaches `ResultsInbox`.
- control state machine: allowed transitions, idempotence, invalid transitions.
- cooperative pause: in-flight completes; next dispatch waits.
- stop: aborts active children and journals one terminal abort.
- lifecycle adapter supplied and worktree path forwarded.
- tier/skills/backend/retries/timeout/signal forwarding for direct agents and helper spawns.
- workflow-owned concurrency permits N children and queues N+1.
- accounting includes agent and helper children; cache reuse does not double-charge.
- source normalization: metadata span removal, async wrapping, legacy CommonJS compatibility, malformed source rejection.
- save validation, atomic write, overwrite, immediate registry refresh, shadow precedence.
- hydration reconstructs terminal/interrupted/checkpoint runs.
- combined panel item rendering and context-sensitive action availability.
- tool delegates every action to the controller and exposes no stub success.
- bounded keyword matching.

### 11.2 Integration tests

Use the existing in-process harness to verify:

1. tool → controller → runner → child → journal/store → result;
2. all five builtin definitions execute by name through the canonical source normalizer;
3. background run returns immediately and later completes;
4. parallel workflow reaches configured concurrency despite the foreground singleton lock;
5. pause/resume/stop behavior;
6. lifecycle workflow step;
7. edit-and-resume cache reuse;
8. interactive checkpoint bridge;
9. save-as then project shadowing;
10. restart hydration and resume.

### 11.3 Mandatory real-Pi smokes

Before merge/tag/publication, load the branch locally with:

```bash
pi --no-extensions -e ./src/index.ts --no-session --approve
```

Run and capture evidence for:

1. Workflows tab lists all five builtins before any run;
2. run a builtin and observe live Workflows and Fleet child rows;
3. pause, resume, and stop a workflow;
4. edit one call and resume, confirming cached prefix and rerun suffix;
5. save a project workflow and verify project-over-builtin shadowing;
6. respond to an interactive checkpoint;
7. interrupt Pi, restart, and resume the recovered workflow.

The smoke window must remain inspectable and its name must be recorded in the release report.

## 12. Release gate

`v0.12.0` may ship only when all conditions are met:

- implementation plan completed through fresh implementer/reviewer tasks;
- no notification-only placeholder behavior remains in the Workflows surface;
- no Critical or Important review findings remain;
- `pnpm typecheck` passes;
- `pnpm test:run` passes completely;
- PR CI passes;
- all seven mandatory real-Pi smokes pass on local branch code;
- package version remains `0.12.0`;
- only then: merge PR #21, tag and push `v0.12.0`, verify npm/GitHub Release, update Pi settings, and smoke the published package.

## 13. Explicitly deferred

The following remain outside this correction:

- cross-extension workflow RPC/event bus (SPEC-6-4);
- persistent child model sessions;
- phase-level budgets;
- hostile-script VM isolation;
- Codex child backend;
- unrelated pre-existing SPEC-6-2 panel stubs.

Everything promised as in-scope by the parent SPEC-6-3—particularly functional panel actions, controls, saved definitions, lifecycle bridge, background execution, recovery, and live state—must be completed before release.
