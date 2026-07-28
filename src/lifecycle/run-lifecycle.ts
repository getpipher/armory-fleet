// src/lifecycle/run-lifecycle.ts
import type { AgentDef } from "../registry/frontmatter.ts";
import type { FleetRunStatus } from "../todo-sync/port.ts";
import type { SpawnResult } from "../engine/spawnSubagent.ts";
import type {
  BackendId, LifecycleDef, LifecycleMode, LifecycleStatus, PhaseRecord, CheckpointDecision,
} from "./lifecycle-types.ts";
import type { GateDef, GateCtx, GateResult, GateRegistry } from "./gates/registry.ts";
import type { Tier } from "../tiers/tier-registry.ts";
import { resolveGates } from "./gates/registry.ts";
import { runGateChain } from "./gates/chain-runner.ts";
import { renderPhasePrompt } from "./prompt-template.ts";
import { parseArtifacts, MAX_REVISE } from "./artifacts-parser.ts";
import {
  createLifecycleTodo, updateProgress, completeLifecycleTodo, revertLifecycleTodo,
  type LifecycleTodoPort, type ProgressPhase,
} from "./lifecycle-todo.ts";

/** A phase spawn is delegated to a `spawn` function (tests inject a fake; production wires spawnSubagent). */
export interface PhaseSpawnOpts {
  agent: string;
  task: string;
  lifecycleTodoId: string;
  /** The merged skill bundle for this phase (lifecycle phase skills ∪ agent's own). */
  skills: string[];
  /** The resolved backend for this phase (phase.backend → lifecycle.backend → "pi"). */
  backend: BackendId;
  model?: string;
}
export type SpawnFn = (opts: PhaseSpawnOpts) => Promise<SpawnResult>;

export interface LifecycleRunDeps {
  registry: Map<string, LifecycleDef>;
  agentRegistry: Map<string, AgentDef>;
  spawn: SpawnFn;
  todoPort: LifecycleTodoPort;
  /** Resolve the backend for a phase: phase.backend → lifecycle.backend → "pi" (+ availability check). */
  resolveBackend: (phaseBackend: BackendId | undefined, lifecycleBackend: BackendId) => BackendId;
  genRunId: () => string;
  /** SPEC-5a (Q3=A): when present, isolated runs use worktree-diff artifact discovery
   *  instead of the prompt-baked `Artifacts:` block parser. Foreground runs leave this undefined. */
  artifactDiscovery?: (o: { finalText: string; cwd: string; baseRef: string; terminal: boolean }) => { summary: string; paths: string[] } | { error: string };
  /** SPEC-6-2: gate registry — when present + a phase has gates, the gate chain runs between parse-artifacts and checkpoint. */
  gateRegistry?: GateRegistry;
  /** SPEC-6-2: provides the gate chain's ctx extras (lifecycle cost, context tokens, tier). When absent, defaults to zeros. */
  getGateCtxState?: (todoId: string, agentName: string) => { lifecycleCost: number; contextTokens: number; tier?: Tier };
  /** SPEC-6-2: resolve a model's context window for the gate ctx. Optional — absent → undefined. */
  getModelContextWindow?: (model: string) => number | undefined;
}

export interface LifecycleRunOpts {
  deps: LifecycleRunDeps;
  mode: LifecycleMode;
  onCheckpoint: CheckpointFn;
  /** SPEC-5a (Q3=A): the worktree path for isolated runs. When set + deps.artifactDiscovery is present,
   *  artifact discovery uses worktree-diff instead of parseArtifacts. Foreground runs leave this undefined. */
  worktreePath?: string;
  /** SPEC-5a: the base ref to diff against (default "HEAD"). */
  baseRef?: string;
}

export interface LifecycleRunResult {
  runId: string;
  lifecycleName: string;
  task: string;
  backend: BackendId;
  mode: LifecycleMode;
  status: LifecycleStatus;
  phases: PhaseRecord[];
  startedAt: number;
  endedAt?: number;
  todoId: string | null;
  error?: string;
}

/** Human (or auto) decision at a checkpoint. SPEC-6-2: widened to include gate results. */
export type CheckpointFn = (phase: PhaseRecord, gateResults: GateResult[]) => Promise<CheckpointDecision>;

export async function runLifecycle(task: string, lifecycleName: string, opts: LifecycleRunOpts): Promise<LifecycleRunResult> {
  const { deps } = opts;
  const startedAt = Date.now();

  // 1. Resolve lifecycle (resolve-time errors → failed result, no todo touched).
  const lifecycle = deps.registry.get(lifecycleName);
  if (!lifecycle) {
    const available = [...deps.registry.keys()].sort().join(", ");
    return failResult("", startedAt, `lifecycle '${lifecycleName}' not found; available: ${available}`, lifecycleName, task, opts.mode, [], null);
  }

  const runId = deps.genRunId();
  const lifecycleBackend = lifecycle.backend;

  // 2. Create the lifecycle TODO (one per lifecycle — Q7=C).
  let todoId: string;
  try {
    todoId = await createLifecycleTodo(deps.todoPort, {
      runId, task, lifecycle: lifecycleName, backend: lifecycleBackend, mode: opts.mode,
      phases: lifecycle.phases.map((p) => p.name),
    });
  } catch (e) {
    return failResult(runId, startedAt, `lifecycle TODO create failed: ${(e as Error).message}`, lifecycleName, task, opts.mode, [], null, lifecycleBackend);
  }

  // Phase-progress state for the todo notes (single source of truth).
  const progressPhases: ProgressPhase[] = lifecycle.phases.map((p) => ({ name: p.name, done: false }));
  const phaseRecords: PhaseRecord[] = [];

  // 3. Phase loop.
  for (let idx = 0; idx < lifecycle.phases.length; idx++) {
    const phaseDef = lifecycle.phases[idx]!;
    const isTerminal = idx === lifecycle.phases.length - 1;

    // a/b: resolve agent + backend
    const agentName = phaseDef.agent ?? "general-purpose";
    if (!deps.agentRegistry.has(agentName)) {
      await revertLifecycleTodo(deps.todoPort, todoId, `agent '${agentName}' not in registry`);
      return failResult(runId, startedAt, `agent '${agentName}' (phase '${phaseDef.name}') not in registry`, lifecycleName, task, opts.mode, phaseRecords, todoId, lifecycleBackend);
    }
    // resolveBackend may throw (e.g. phase requests claude when claude is unavailable) — §12.
    let backend: BackendId;
    try {
      backend = deps.resolveBackend(phaseDef.backend, lifecycleBackend);
    } catch (e) {
      await revertLifecycleTodo(deps.todoPort, todoId, `backend resolve failed: ${(e as Error).message}`);
      return failResult(runId, startedAt, (e as Error).message, lifecycleName, task, opts.mode, phaseRecords, todoId, lifecycleBackend);
    }
    const agentDef = deps.agentRegistry.get(agentName)!;
    const skills = mergeSkills(phaseDef.skills, agentDef.skills ?? []);

    // Revise loop (runs the phase, then checkpoints; on Revise, re-runs with feedback)
    let reviseCount = 0;
    // Per-phase scratch for the revise feedback: the current phase's own prior attempt summary +
    // the human's feedback. Reset each phase (a phase's revise context is its own, not a prior phase's).
    let priorAttemptSummary = "";
    let lastFeedback: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const prev = phaseRecords.length > 0 ? phaseRecords[phaseRecords.length - 1] : undefined;
      const feedback = reviseCount > 0
        ? `Prior attempt summary: ${priorAttemptSummary.slice(0, 500)}\n\nHuman feedback: ${lastFeedback ?? ""}`
        : undefined;
      const prompt = renderPhasePrompt(phaseDef.promptTemplate, {
        task, lifecycle: lifecycleName, phase: phaseDef.name,
        prev: prev ? { name: prev.name, summary: prev.summary, paths: prev.paths } : undefined,
        feedback,
        challengeStep: phaseDef.challengeStep,
      });

      // e/f: spawn the phase child (links to the lifecycle todo; skips mark-done/revert — Task 8).
      // The merged skill bundle + resolved backend are threaded so the real spawn injects the
      // phase's skills (Q1=B) and routes to the phase's backend (Q4=C) — not the agent's defaults.
      let spawnRes: import("../engine/spawnSubagent.ts").SpawnResult;
      try {
        spawnRes = await deps.spawn({ agent: agentName, task: prompt, lifecycleTodoId: todoId, skills, backend });
      } catch (e) {
        // spawn should return a failed result, not throw — but guard anyway so a throwing spawn
        // can't orphan the lifecycle (treat as a phase failure).
        spawnRes = { status: "failed", finalText: "", runId: "fl-err", todoId, agent: agentName, model: "", durationMs: 0, tokenTotal: 0, error: (e as Error).message };
      }

      // g: parse artifacts (terminal phase exempts a missing block).
      let phaseRec: PhaseRecord;
      if (spawnRes.status === "failed") {
        phaseRec = { name: phaseDef.name, summary: spawnRes.error ?? spawnRes.finalText.slice(0, 120), paths: [], status: "failed", reviseCount };
      } else if (deps.artifactDiscovery && opts.worktreePath) {
        // SPEC-5a (Q3=A): isolated run — structural worktree-diff (robust to models that omit the Artifacts block).
        const art = deps.artifactDiscovery({ finalText: spawnRes.finalText, cwd: opts.worktreePath, baseRef: opts.baseRef ?? "HEAD", terminal: isTerminal });
        if ("error" in art) {
          phaseRec = { name: phaseDef.name, summary: art.error, paths: [], status: "failed", reviseCount };
        } else {
          phaseRec = { name: phaseDef.name, summary: art.summary, paths: art.paths, status: "completed", reviseCount };
        }
      } else {
        const art = parseArtifacts(spawnRes.finalText, { terminal: isTerminal });
        if ("error" in art) {
          phaseRec = { name: phaseDef.name, summary: art.error, paths: [], status: "failed", reviseCount };
        } else {
          phaseRec = { name: phaseDef.name, summary: art.summary, paths: art.paths, status: "completed", reviseCount };
        }
      }

      // Capture this attempt's summary for the next revise iteration's feedback digest.
      priorAttemptSummary = phaseRec.summary;

      // SPEC-6-2: gate chain — runs between parse-artifacts and checkpoint.
      // If the gate chain short-circuits (revise/abort), we handle it here BEFORE the checkpoint.
      let gateResults: GateResult[] = [];
      if (phaseDef.gates && phaseDef.gates.length > 0 && deps.gateRegistry) {
        const gates = resolveGates(phaseDef.gates, deps.gateRegistry);
        const gateCtxState = deps.getGateCtxState?.(todoId, agentName) ?? { lifecycleCost: 0, contextTokens: 0 };
        const gateCtx: GateCtx = {
          phaseRec, spawnRes,
          lifecycle: { name: lifecycleName, task, todoId, backend: lifecycleBackend },
          tier: gateCtxState.tier,
          lifecycleCost: gateCtxState.lifecycleCost,
          contextTokens: gateCtxState.contextTokens,
          worktreePath: opts.worktreePath,
          spawn: deps.spawn,
          getModelContextWindow: deps.getModelContextWindow ?? (() => undefined),
        };
        const outcome = await runGateChain({ gates, ctx: gateCtx });
        gateResults = outcome.results;
        phaseRec.gateResults = gateResults;
        if (outcome.shortCircuit?.action === "revise") {
          reviseCount++;
          lastFeedback = outcome.shortCircuit.feedback;
          if (reviseCount > MAX_REVISE) {
            await updateProgress(deps.todoPort, todoId, {
              phase: phaseDef.name, done: false, last: `gate revise budget exhausted (${MAX_REVISE})`, revising: false, attempt: reviseCount,
            }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
            phaseRecords.push(phaseRec);
            return doneResult(runId, startedAt, "failed", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId,
              `gate revise budget exhausted (${MAX_REVISE})`);
          }
          await updateProgress(deps.todoPort, todoId, {
            phase: phaseDef.name, done: false, last: `gate revise (attempt ${reviseCount}/${MAX_REVISE}): ${outcome.shortCircuit.feedback?.slice(0, 80)}`, revising: true, attempt: reviseCount,
          }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
          continue; // re-run the phase
        }
        if (outcome.shortCircuit?.action === "abort") {
          await revertLifecycleTodo(deps.todoPort, todoId, `gate aborted: ${outcome.shortCircuit.reason}`);
          phaseRecords.push(phaseRec);
          return doneResult(runId, startedAt, "failed", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId, outcome.shortCircuit.reason);
        }
      }

      // h: update the lifecycle todo progress block.
      await updateProgress(deps.todoPort, todoId, {
        phase: phaseDef.name, done: phaseRec.status === "completed",
        last: `${phaseDef.name} ${phaseRec.status}${phaseRec.paths.length ? " — " + phaseRec.paths.join(", ") : ""}`,
        revising: false, attempt: reviseCount,
      }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });

      // i: checkpoint decision.
      const forceCheckpoint = phaseRec.status === "failed"; // failure forces a checkpoint regardless of auto/checkpoint
      const shouldCheckpoint = forceCheckpoint || (phaseDef.checkpoint !== false && opts.mode === "checkpointed" && !isTerminal);
      if (!shouldCheckpoint) {
        phaseRecords.push(phaseRec);
        break; // advance to next phase
      }

      const decision = await opts.onCheckpoint(phaseRec, gateResults);
      if (decision.action === "continue") {
        if (forceCheckpoint) {
          // cannot continue past a failure — treat as abort (guard against a misbehaving checkpoint fn)
          await revertLifecycleTodo(deps.todoPort, todoId, `cannot continue past failed phase '${phaseDef.name}'`);
          phaseRecords.push(phaseRec);
          return doneResult(runId, startedAt, "aborted", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId);
        }
        phaseRecords.push(phaseRec);
        break; // advance
      }
      if (decision.action === "abort") {
        await revertLifecycleTodo(deps.todoPort, todoId, `aborted at phase '${phaseDef.name}'`);
        phaseRecords.push(phaseRec);
        // A failed phase that's aborted = lifecycle failed (the work failed); a healthy phase
        // aborted at a checkpoint = user-aborted (§12).
        const status: LifecycleStatus = phaseRec.status === "failed" ? "failed" : "aborted";
        // SPEC-5a fix: surface the failed phase's summary as the lifecycle error so the async
        // runner's run:aborted journal event + notify show the real cause (spawnRes.error etc.),
        // not just the bare status. Guard on non-empty summary so an empty summary still falls
        // back to the status in the async runner (res.error ?? res.status). A healthy phase
        // aborted at a checkpoint has no error.
        const error = phaseRec.status === "failed" && phaseRec.summary ? phaseRec.summary : undefined;
        return doneResult(runId, startedAt, status, lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId, error);
      }
      // decision.action === "revise"
      reviseCount++;
      lastFeedback = decision.feedback;
      if (reviseCount > MAX_REVISE) {
        await updateProgress(deps.todoPort, todoId, {
          phase: phaseDef.name, done: false, last: `revise budget exhausted (${MAX_REVISE})`, revising: false, attempt: reviseCount,
        }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
        phaseRecords.push(phaseRec);
        return doneResult(runId, startedAt, "failed", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId,
          `phase '${phaseDef.name}' revise budget exhausted (${MAX_REVISE})`);
      }
      // mark revising in the progress block, then loop to re-run this phase
      await updateProgress(deps.todoPort, todoId, {
        phase: phaseDef.name, done: false, last: `revising (attempt ${reviseCount}/${MAX_REVISE})`, revising: true, attempt: reviseCount,
      }, { lifecycle: lifecycleName, task, backend: lifecycleBackend, mode: opts.mode, phases: progressPhases });
      // loop continues — re-run the phase with feedback
    }
  }

  // j: terminal phase completed → lifecycle done.
  await completeLifecycleTodo(deps.todoPort, todoId, `lifecycle '${lifecycleName}' completed`);
  return doneResult(runId, startedAt, "completed", lifecycleName, task, lifecycleBackend, opts.mode, phaseRecords, todoId);
}

/** Merge lifecycle phase skills + agent's own skills (lifecycle first; agent can only add — Q3=B). */
function mergeSkills(phaseSkills: string[], agentSkills: string[]): string[] {
  const out = [...phaseSkills];
  for (const s of agentSkills) if (!out.includes(s)) out.push(s);
  return out;
}

function failResult(
  runId: string, startedAt: number, error: string, lifecycleName: string, task: string,
  mode: LifecycleMode, phases: PhaseRecord[], todoId: string | null, backend: BackendId = "pi",
): LifecycleRunResult {
  return { runId, lifecycleName, task, backend, mode, status: "failed", phases, startedAt, endedAt: Date.now(), todoId, error };
}

function doneResult(
  runId: string, startedAt: number, status: LifecycleStatus, lifecycleName: string, task: string,
  backend: BackendId, mode: LifecycleMode, phases: PhaseRecord[], todoId: string | null, error?: string,
): LifecycleRunResult {
  return { runId, lifecycleName, task, backend, mode, status, phases, startedAt, endedAt: Date.now(), todoId, error };
}