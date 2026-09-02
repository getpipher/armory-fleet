// src/rpc/rpc-server.ts
// SPEC-6-4 — the fleet:rpc verb surface. Frozen: verb names, param contracts, reply envelope
// { id, ok, data | error{code,message} }, and the error-code enum — all pinned by
// test/rpc-server.test.mts. handle() NEVER throws and replies EXACTLY once per request.
import { genRunId } from "../engine/run-registry.ts";
import type { RunRegistry, RunRecord } from "../engine/run-registry.ts";
import type { RunLog } from "../runtime/run-log.ts";
import type { RunJournal } from "../runtime/run-journal.ts";
import { resolveDispatchCwd } from "../tools/subagent.ts";
import { isSessionRejection } from "../engine/session-rejection.ts";

export type RpcErrorCode =
  | "E-CONTROL-DISABLED" | "E-RUN-NOT-FOUND" | "E-RUN-FINISHED" | "E-BAD-VERB"
  | "E-BAD-PARAMS" | "E-STEER-UNSUPPORTED" | "E-INTERNAL";

export interface RpcRequest { id: string; verb: string; params?: unknown }
export type RpcReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: RpcErrorCode; message: string } };

/** SPEC-6-4 gate: ON unless ARMORY_FLEET_RPC_CONTROL is "0"/"false" (case-insensitive).
 *  Read-only verbs (observe/status) ignore this. Honest threat model: in-process extensions
 *  already have full system access via pi itself — the gate guards accidents, not adversaries. */
export function rpcControlEnabled(env: string | undefined = process.env.ARMORY_FLEET_RPC_CONTROL): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false");
}

export interface RpcRunSummary {
  runId: string; agent: string; model: string; status: string; startedAt: number;
  endedAt?: number; task: string; cwd?: string; resultSummary?: string; tokenTotal?: number; sessionKey?: string;
}

export interface RpcServerDeps {
  runRegistry: Pick<RunRegistry, "get" | "list">;
  runLog: Pick<RunLog, "replay">;
  journal: Pick<RunJournal, "replay">;
  parentCwd: string;
  hasAsyncRunner: boolean;
  /** Detached spawn: index.ts builds the real spawnSubagent invocation (foreground or bg routing).
   *  Never throws — runtime failures land via the registry + RunLog journal (spawnSubagent's own
   *  fail path journals run:ended), so the caller's { runId } always resolves to a real run. */
  spawn: (params: Record<string, unknown>, runId: string) => void;
  /** #83: schedule registration (scheduler.register under the hood). Throws on an invalid
   *  expression (surfaced as E-BAD-PARAMS); absent = scheduling not configured in this session. */
  schedule?: (spec: Record<string, unknown>) => { scheduleId: string; nextFire: string | null };
}

const LIST_CAP = 25;
const TASK_SUMMARY_CAP = 80;

function summarize(r: RunRecord): RpcRunSummary {
  const task = r.task.length > TASK_SUMMARY_CAP ? r.task.slice(0, TASK_SUMMARY_CAP - 1) + "…" : r.task;
  return {
    runId: r.runId, agent: r.agent, model: r.model, status: r.status, startedAt: r.startedAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    task, ...(r.cwd ? { cwd: r.cwd } : {}),
    ...(r.resultSummary !== undefined ? { resultSummary: r.resultSummary } : {}),
    ...(r.tokenTotal !== undefined ? { tokenTotal: r.tokenTotal } : {}),
    ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}),
  };
}

export class RpcServer {
  constructor(
    private readonly deps: RpcServerDeps,
    private readonly controlEnabled: () => boolean = rpcControlEnabled,
  ) {}

  /** Returns the reply, or null for a malformed request with no usable id (caller drops).
   *  Never throws — a handler exception becomes E-INTERNAL. */
  async handle(req: unknown): Promise<RpcReply | null> {
    const id = requestId(req);
    try {
      return await this.dispatch(req, id);
    } catch (e) {
      if (!id) return null;
      return { id, ok: false, error: { code: "E-INTERNAL", message: `unexpected rpc failure: ${(e as Error).message}` } };
    }
  }

  private async dispatch(req: unknown, id: string | null): Promise<RpcReply | null> {
    if (!req || typeof req !== "object" || !id) return null;
    const { verb, params } = req as Record<string, unknown>;
    if (typeof verb !== "string") return this.err(id, "E-BAD-VERB", "missing verb");
    const gated = this.controlEnabled();
    switch (verb) {
      case "spawn": return gated ? this.spawnVerb(id, params) : this.controlDisabled(id);
      case "steer": return gated ? this.steerVerb(id, params) : this.controlDisabled(id);
      case "abort": return gated ? this.abortVerb(id, params) : this.controlDisabled(id);
      case "schedule": return gated ? this.scheduleVerb(id, params) : this.controlDisabled(id);
      case "observe": return this.observeVerb(id, params);
      case "status": return this.statusVerb(id, params);
      default: return this.err(id, "E-BAD-VERB", `unknown verb '${verb}' (known: spawn, steer, observe, abort, status, schedule)`);
    }
  }

  private controlDisabled(id: string): RpcReply {
    return this.err(id, "E-CONTROL-DISABLED", "fleet rpc control is disabled (ARMORY_FLEET_RPC_CONTROL is set to off; remove it or set it to 1 to enable spawn/steer/abort/schedule)");
  }

  private err(id: string, code: RpcErrorCode, message: string): RpcReply {
    return { id, ok: false, error: { code, message } };
  }

  private obj(params: unknown): Record<string, unknown> | null {
    return params && typeof params === "object" ? params as Record<string, unknown> : null;
  }

  private spawnVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "spawn requires params: { agent, task, ... }");
    if (typeof p.agent !== "string" || !p.agent) return this.err(id, "E-BAD-PARAMS", "params.agent must be a non-empty string");
    if (typeof p.task !== "string" || !p.task) return this.err(id, "E-BAD-PARAMS", "params.task must be a non-empty string");
    if (p.lifecycle !== undefined && (typeof p.lifecycle !== "string" || !p.lifecycle)) return this.err(id, "E-BAD-PARAMS", "params.lifecycle must be a non-empty string when set (#83)");
    if (p.schedule !== undefined) return this.err(id, "E-BAD-PARAMS", "params.schedule is not a spawn param — schedules run lifecycles, not single delegates; use the 'schedule' verb (#83)");
    if (p.modelFallback !== undefined && (typeof p.modelFallback !== "string" || !p.modelFallback)) return this.err(id, "E-BAD-PARAMS", "params.modelFallback must be a non-empty string when set (#83)");
    if (p.cwd !== undefined && (typeof p.cwd !== "string" || p.cwd === "")) return this.err(id, "E-BAD-PARAMS", "params.cwd must be a non-empty string when set");
    if (p.cwd !== undefined) {
      const { error } = resolveDispatchCwd(p.cwd, this.deps.parentCwd);
      if (error) return this.err(id, "E-BAD-PARAMS", error);
    }
    if (p.background !== undefined && typeof p.background !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.background must be a boolean");
    if (p.background && !this.deps.hasAsyncRunner) return this.err(id, "E-BAD-PARAMS", "background runs not configured in this session (asyncRunner missing)");
    if (p.isolation !== undefined && p.isolation !== "worktree" && p.isolation !== "none" && p.isolation !== "auto") {
      return this.err(id, "E-BAD-PARAMS", "params.isolation must be 'worktree' | 'none' | 'auto'");
    }
    if (p.maxTurns !== undefined && (typeof p.maxTurns !== "number" || !Number.isInteger(p.maxTurns) || p.maxTurns < 1)) {
      return this.err(id, "E-BAD-PARAMS", "params.maxTurns must be a positive integer");
    }
    if (p.readOnly !== undefined && typeof p.readOnly !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.readOnly must be a boolean");
    if (p.track !== undefined && typeof p.track !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.track must be a boolean");
    if (p.todoId !== undefined && typeof p.todoId !== "string") return this.err(id, "E-BAD-PARAMS", "params.todoId must be a string");
    if (p.model !== undefined && (typeof p.model !== "string" || !p.model)) return this.err(id, "E-BAD-PARAMS", "params.model must be a non-empty string when set");
    if (p.skills !== undefined && (!Array.isArray(p.skills) || !p.skills.every((s) => typeof s === "string"))) {
      return this.err(id, "E-BAD-PARAMS", "params.skills must be an array of strings");
    }
    const runId = genRunId();
    this.deps.spawn(p, runId);
    return { id, ok: true, data: { runId } };
  }

  /** #83 D4: register a recurring lifecycle run. Reply shape { scheduleId, nextFire } — schedules
   *  are NOT runs, so no runId (spawn's uniform { runId } contract stays unbranched). */
  private scheduleVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "schedule requires params: { task, expression, ... }");
    if (typeof p.task !== "string" || !p.task) return this.err(id, "E-BAD-PARAMS", "params.task must be a non-empty string");
    if (typeof p.expression !== "string" || !p.expression) return this.err(id, "E-BAD-PARAMS", "params.expression must be a non-empty string (cron or interval, e.g. '*/5 * * * *' or '30m')");
    if (p.lifecycle !== undefined && (typeof p.lifecycle !== "string" || !p.lifecycle)) return this.err(id, "E-BAD-PARAMS", "params.lifecycle must be a non-empty string when set");
    if (p.auto !== undefined && typeof p.auto !== "boolean") return this.err(id, "E-BAD-PARAMS", "params.auto must be a boolean");
    if (p.isolation !== undefined && p.isolation !== "worktree" && p.isolation !== "none" && p.isolation !== "auto") {
      return this.err(id, "E-BAD-PARAMS", "params.isolation must be 'worktree' | 'none' | 'auto'");
    }
    if (p.cwd !== undefined && (typeof p.cwd !== "string" || p.cwd === "")) return this.err(id, "E-BAD-PARAMS", "params.cwd must be a non-empty string when set");
    let cwd: string | undefined;
    if (p.cwd !== undefined) {
      const resolved = resolveDispatchCwd(p.cwd, this.deps.parentCwd);
      if (resolved.error) return this.err(id, "E-BAD-PARAMS", resolved.error);
      cwd = resolved.cwd;
    }
    if (!this.deps.schedule) {
      return this.err(id, "E-BAD-PARAMS", "scheduling not configured in this session (scheduler missing)");
    }
    try {
      const out = this.deps.schedule({
        task: p.task, expression: p.expression,
        ...(p.lifecycle !== undefined ? { lifecycle: p.lifecycle } : {}),
        ...(p.auto !== undefined ? { auto: p.auto } : {}),
        ...(p.isolation !== undefined ? { isolation: p.isolation } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return { id, ok: true, data: { scheduleId: out.scheduleId, nextFire: out.nextFire } };
    } catch (e) {
      return this.err(id, "E-BAD-PARAMS", (e as Error).message || "schedule registration failed");
    }
  }

  private statusVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params) ?? {};
    if (p.runId !== undefined) {
      if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
      const rec = this.deps.runRegistry.get(p.runId);
      if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry (finished runs older than the session are not listed)`);
      return { id, ok: true, data: { runs: [summarize(rec)] } };
    }
    const runs = this.deps.runRegistry.list();
    const capped = runs.slice(0, LIST_CAP).map(summarize);
    // #84: surface the omitted count so RPC consumers know the list is partial. Absent
    // when everything fit (additive field — consumers check presence, not falseness).
    const truncated = runs.length - capped.length;
    return { id, ok: true, data: truncated > 0 ? { runs: capped, truncated } : { runs: capped } };
  }

  private observeVerb(id: string, params: unknown): RpcReply {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "observe requires params: { runId, tier? }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    const tier = p.tier ?? "both";
    if (tier !== "lifecycle" && tier !== "child" && tier !== "both") {
      return this.err(id, "E-BAD-PARAMS", "params.tier must be 'lifecycle' | 'child' | 'both'");
    }
    const logEvents = this.deps.runLog.replay(p.runId);
    const journalEvents = this.deps.journal.replay(p.runId);
    if (logEvents.length === 0 && journalEvents.length === 0) {
      return this.err(id, "E-RUN-NOT-FOUND", `no journaled run '${p.runId}'`);
    }
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    // Seq = position in the FULL store event list (index + 1) — identical to the live bus's
    // per-store dense counting, so the (channel, runId, seq) dedupe contract holds across
    // the live→replay handoff. Tier filters decide WHICH entries emit, not how they count.
    // Journal exception: the live bus increments phaseSeq ONLY on the three phase types, so
    // replay filters to phases BEFORE counting — real lifecycle runs bookend the journal with
    // run:started/completed, and position-in-full-list would overshoot by the bookends.
    const phases = journalEvents.filter((e) => e.type === "phase:started" || e.type === "phase:completed" || e.type === "phase:failed");
    if (tier === "lifecycle" || tier === "both") {
      logEvents.forEach((e, i) => {
        if (e.type === "run:meta") {
          events.push({ channel: "fleet:run:started", payload: { seq: i + 1, agent: e.agent, model: e.model, cwd: e.cwd, sessionCwd: e.sessionCwd, mode: e.mode ?? "foreground", task: e.task, ts: e.startedAt } });
        } else if (e.type === "run:ended") {
          events.push({
            channel: "fleet:run:ended",
            payload: { seq: i + 1, status: e.status, ts: e.endedAt,
              ...(e.resultSummary !== undefined ? { result: e.resultSummary } : {}),
              ...(e.error !== undefined ? { error: e.error } : {}),
              ...(e.filesTouched !== undefined ? { filesTouched: e.filesTouched } : {}),
              ...(e.toolCallCount !== undefined ? { toolCallCount: e.toolCallCount } : {}),
              ...(e.languageDrift !== undefined ? { languageDrift: e.languageDrift } : {}),
              ...(e.languageDriftRatio !== undefined ? { languageDriftRatio: e.languageDriftRatio } : {}) },
          });
        }
      });
      phases.forEach((e, i) => {
        if (e.type === "phase:started") events.push({ channel: "fleet:phase:started", payload: { seq: i + 1, phase: e.phase, ts: e.ts } });
        else if (e.type === "phase:completed") events.push({ channel: "fleet:phase:completed", payload: { seq: i + 1, phase: e.phase, summary: e.summary, paths: e.paths, ts: e.ts } });
        else if (e.type === "phase:failed") events.push({ channel: "fleet:phase:failed", payload: { seq: i + 1, phase: e.phase, error: e.error, ts: e.ts } });
      });
    }
    if (tier === "child" || tier === "both") {
      logEvents.forEach((e, i) => {
        if (e.type === "message") events.push({ channel: "fleet:child:message", payload: { seq: i + 1, role: e.role, text: e.text } });
        else if (e.type === "tool") events.push({ channel: "fleet:child:tool", payload: { seq: i + 1, toolName: e.toolName, args: e.args, result: e.result, isError: e.isError } });
      });
    }
    return { id, ok: true, data: { runId: p.runId, tier, events } };
  }

  private async steerVerb(id: string, params: unknown): Promise<RpcReply> {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "steer requires params: { runId, message }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    if (typeof p.message !== "string" || !p.message) return this.err(id, "E-BAD-PARAMS", "params.message must be a non-empty string");
    const rec = this.deps.runRegistry.get(p.runId);
    if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry`);
    const session = rec.session;
    if (!session) return this.err(id, "E-RUN-FINISHED", `run '${p.runId}' has no live session (status: ${rec.status})`);
    if (!session.supportsSteer) return this.err(id, "E-STEER-UNSUPPORTED", `run '${p.runId}' backend has no steer support (claude children)`);
    try {
      await session.steer(p.message);
    } catch (e) {
      // #84: typed rejections match by reason; string matching survives as a back-compat
      // fallback for third-party ChildSession implementations that bubble bare Errors.
      if (isSessionRejection(e) && e.reason === "steer-unsupported") return this.err(id, "E-STEER-UNSUPPORTED", e.message);
      const msg = (e as Error).message ?? "steer failed";
      if (msg.includes("not supported")) return this.err(id, "E-STEER-UNSUPPORTED", msg);
      return this.err(id, "E-INTERNAL", `steer failed: ${msg}`);
    }
    return { id, ok: true, data: { steered: true } };
  }

  private async abortVerb(id: string, params: unknown): Promise<RpcReply> {
    const p = this.obj(params);
    if (!p) return this.err(id, "E-BAD-PARAMS", "abort requires params: { runId }");
    if (typeof p.runId !== "string" || !p.runId) return this.err(id, "E-BAD-PARAMS", "params.runId must be a non-empty string");
    const rec = this.deps.runRegistry.get(p.runId);
    if (!rec) return this.err(id, "E-RUN-NOT-FOUND", `no live run '${p.runId}' in the registry`);
    const session = rec.session;
    if (!session) return this.err(id, "E-RUN-FINISHED", `run '${p.runId}' has no live session (status: ${rec.status})`);
    try {
      await session.abort();
    } catch (e) {
      // #84: typed first (reason-based), string fallback for bare-Error handles.
      if (isSessionRejection(e) && (e.reason === "already-aborted" || e.reason === "already-processing")) return this.err(id, "E-RUN-FINISHED", e.message);
      const msg = (e as Error).message ?? "abort failed";
      if (msg.includes("already")) return this.err(id, "E-RUN-FINISHED", msg);
      return this.err(id, "E-INTERNAL", `abort failed: ${msg}`);
    }
    return { id, ok: true, data: { aborted: true } };
  }
}

function requestId(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const id = (req as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}
