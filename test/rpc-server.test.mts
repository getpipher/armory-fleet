// test/rpc-server.test.mts — SPEC-6-4 Task 4: RPC verbs, gate, error codes (frozen surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { RunRegistry, type RunRecord } from "../src/engine/run-registry.ts";
import { FleetEventBus } from "../src/rpc/event-bus.ts";
import { RpcServer, rpcControlEnabled } from "../src/rpc/rpc-server.ts";
import { SessionRejectionError } from "../src/engine/session-rejection.ts";

function harness(over: Partial<ConstructorParameters<typeof RpcServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rpc-"));
  const runLog = new RunLog(join(dir, "conversations"));
  const journal = new RunJournal(join(dir, "runs"));
  const registry = new RunRegistry();
  let spawned: Array<{ params: Record<string, unknown>; runId: string }> = [];
  const deps = {
    runRegistry: registry, runLog, journal,
    parentCwd: dir, hasAsyncRunner: false,
    spawn: (params: Record<string, unknown>, runId: string) => { spawned.push({ params, runId }); },
    ...over,
  };
  const server = new RpcServer(deps, () => true);
  return { dir, runLog, journal, registry, server, deps, spawned: () => spawned };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "fl-x", agent: "scout", model: "Test/m", task: "t", track: false, todoId: null,
    status: "running", startedAt: 1, cwd: "/tmp", ...over,
  } as RunRecord;
}

test("rpcControlEnabled: default on, 0/false off (case-insensitive), anything else on", () => {
  assert.equal(rpcControlEnabled(undefined), true);
  assert.equal(rpcControlEnabled(""), true);
  assert.equal(rpcControlEnabled("1"), true);
  assert.equal(rpcControlEnabled("0"), false);
  assert.equal(rpcControlEnabled("FALSE"), false);
  assert.equal(rpcControlEnabled(" false "), false);
});

test("malformed requests (no id / not an object) → null (caller drops)", async () => {
  const h = harness();
  try {
    assert.equal(await h.server.handle(null), null);
    assert.equal(await h.server.handle("nope"), null);
    assert.equal(await h.server.handle({ verb: "status" }), null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("unknown verb → E-BAD-VERB; gate off → E-CONTROL-DISABLED on control verbs only", async () => {
  const h = harness();
  try {
    const bad = await h.server.handle({ id: "1", verb: "explode" });
    assert.equal((bad as { error: { code: string } }).error.code, "E-BAD-VERB");
    const gated = new RpcServer(h.deps, () => false);
    const r1 = await gated.handle({ id: "2", verb: "spawn", params: { agent: "a", task: "t" } });
    assert.equal((r1 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r2 = await gated.handle({ id: "3", verb: "steer", params: { runId: "fl-x", message: "m" } });
    assert.equal((r2 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r3 = await gated.handle({ id: "4", verb: "abort", params: { runId: "fl-x" } });
    assert.equal((r3 as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
    const r4 = await gated.handle({ id: "5", verb: "status", params: {} });
    assert.equal((r4 as { ok: boolean }).ok, true, "read-only status is never gated");
    const r5 = await gated.handle({ id: "6", verb: "observe", params: { runId: "fl-x" } });
    assert.equal((r5 as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND", "read-only observe is never gated (reaches the verb, not the gate)");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("spawn: validates params, pre-mints runId, calls the detached spawn, returns { runId }", async () => {
  const h = harness();
  try {
    const r = await h.server.handle({ id: "s1", verb: "spawn", params: { agent: "scout", task: "go" } }) as { ok: true; data: { runId: string } };
    assert.equal(r.ok, true);
    assert.match(r.data.runId, /^fl-/);
    assert.equal(h.spawned().length, 1);
    assert.equal(h.spawned()[0]!.runId, r.data.runId, "the pre-minted runId is handed to the spawn");
    assert.equal(h.spawned()[0]!.params.agent, "scout");
    const bad = await h.server.handle({ id: "s2", verb: "spawn", params: { agent: "", task: "go" } });
    assert.equal((bad as { error: { code: string } }).error.code, "E-BAD-PARAMS");
    const life = await h.server.handle({ id: "s3", verb: "spawn", params: { agent: "a", task: "t", lifecycle: "default" } }) as { ok: true; data: { runId: string } };
    assert.equal(life.ok, true, "lifecycle over RPC is accepted (#83 — spec §7 deferral lifted)");
    assert.equal(h.spawned().length, 2);
    assert.equal(h.spawned()[1]!.params.lifecycle, "default", "lifecycle passes through to the detached spawn");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("spawn: lifecycle + modelFallback validate as non-empty strings; valid values pass through (#83)", async () => {
  const h = harness({ hasAsyncRunner: true });
  try {
    for (const params of [
      { agent: "a", task: "t", lifecycle: "" },
      { agent: "a", task: "t", lifecycle: 42 },
      { agent: "a", task: "t", modelFallback: "" },
      { agent: "a", task: "t", modelFallback: 7 },
    ]) {
      const r = await h.server.handle({ id: "v", verb: "spawn", params }) as { error: { code: string; message: string } };
      assert.equal(r.error.code, "E-BAD-PARAMS", JSON.stringify(params));
      assert.equal(h.spawned().length, 0, "no ghost runId on validation failure");
    }
    const ok = await h.server.handle({ id: "ok", verb: "spawn", params: { agent: "a", task: "t", lifecycle: "review", modelFallback: "anthropic/claude-sonnet-4", background: true } }) as { ok: true; data: { runId: string } };
    assert.equal(ok.ok, true);
    assert.equal(h.spawned()[0]!.params.lifecycle, "review");
    assert.equal(h.spawned()[0]!.params.modelFallback, "anthropic/claude-sonnet-4");
    assert.equal(h.spawned()[0]!.params.background, true);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("schedule: gated like other control verbs (#83)", async () => {
  const h = harness();
  const gated = new RpcServer(h.deps, () => false);
  try {
    const r = await gated.handle({ id: "g", verb: "schedule", params: { task: "t", expression: "*/5 * * * *" } });
    assert.equal((r as { error: { code: string } }).error.code, "E-CONTROL-DISABLED");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("schedule: scheduler not configured → actionable E-BAD-PARAMS (#83)", async () => {
  const h = harness(); // no `schedule` dep wired
  try {
    const r = await h.server.handle({ id: "n", verb: "schedule", params: { task: "t", expression: "*/5 * * * *" } }) as { error: { code: string; message: string } };
    assert.equal(r.error.code, "E-BAD-PARAMS");
    assert.match(r.error.message, /scheduler/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("schedule: validates task + expression + optional fields, then replies { scheduleId, nextFire } (#83)", async () => {
  const registered: Array<Record<string, unknown>> = [];
  const h = harness({
    schedule: (spec: Record<string, unknown>) => {
      registered.push(spec);
      return { scheduleId: "sch-abc", nextFire: "2026-09-01T00:00:00.000Z" };
    },
  });
  try {
    for (const params of [
      {},
      { task: "t" },
      { task: "", expression: "*/5 * * * *" },
      { task: "t", expression: "" },
      { task: "t", expression: "*/5 * * * *", lifecycle: "" },
      { task: "t", expression: "*/5 * * * *", auto: "yes" },
      { task: "t", expression: "*/5 * * * *", isolation: "yolo" },
      { task: "t", expression: "*/5 * * * *", cwd: "/does/not/exist" },
    ]) {
      const r = await h.server.handle({ id: "v", verb: "schedule", params }) as { error: { code: string } };
      assert.equal(r.error.code, "E-BAD-PARAMS", JSON.stringify(params));
      assert.equal(registered.length, 0, "nothing registers on validation failure");
    }
    const ok = await h.server.handle({ id: "s", verb: "schedule", params: { task: "sweep", expression: "*/5 * * * *", lifecycle: "review", auto: false, isolation: "none" } }) as { ok: true; data: { scheduleId: string; nextFire: string | null } };
    assert.equal(ok.ok, true);
    assert.equal(ok.data.scheduleId, "sch-abc");
    assert.equal(ok.data.nextFire, "2026-09-01T00:00:00.000Z");
    assert.equal(registered.length, 1);
    assert.equal(registered[0]!.task, "sweep");
    assert.equal(registered[0]!.expression, "*/5 * * * *");
    assert.equal(registered[0]!.lifecycle, "review");
    assert.equal(registered[0]!.auto, false);
    assert.equal(registered[0]!.isolation, "none");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("schedule: scheduler.register throwing (invalid expression) → E-BAD-PARAMS with the parser message (#83)", async () => {
  const h = harness({
    schedule: (_spec: Record<string, unknown>) => { throw new Error("invalid cron expression: 'nope'"); },
  });
  try {
    const r = await h.server.handle({ id: "e", verb: "schedule", params: { task: "t", expression: "nope" } }) as { error: { code: string; message: string } };
    assert.equal(r.error.code, "E-BAD-PARAMS");
    assert.match(r.error.message, /invalid cron expression/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("spawn: invalid cwd → E-BAD-PARAMS before minting (no ghost runId)", async () => {
  const h = harness();
  try {
    const r = await h.server.handle({ id: "c1", verb: "spawn", params: { agent: "a", task: "t", cwd: "/does/not/exist" } });
    assert.equal((r as { error: { code: string } }).error.code, "E-BAD-PARAMS");
    assert.equal(h.spawned().length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("status: single run + list (newest-first, capped) with the summary shape", async () => {
  const h = harness();
  try {
    h.registry.add(record({ runId: "fl-old", startedAt: 1, status: "completed", endedAt: 2, resultSummary: "done", tokenTotal: 5 }));
    h.registry.add(record({ runId: "fl-new", startedAt: 9, cwd: "/w" }));
    const one = await h.server.handle({ id: "q1", verb: "status", params: { runId: "fl-new" } }) as { ok: true; data: { runs: Array<Record<string, unknown>> } };
    assert.equal(one.data.runs.length, 1);
    assert.deepEqual(
      { runId: one.data.runs[0]!.runId, status: one.data.runs[0]!.status, cwd: one.data.runs[0]!.cwd },
      { runId: "fl-new", status: "running", cwd: "/w" },
    );
    const all = await h.server.handle({ id: "q2", verb: "status", params: {} }) as { ok: true; data: { runs: Array<Record<string, unknown>> } };
    assert.deepEqual(all.data.runs.map((r) => r.runId), ["fl-new", "fl-old"], "newest-first");
    const missing = await h.server.handle({ id: "q3", verb: "status", params: { runId: "fl-nope" } });
    assert.equal((missing as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("observe: replay shapes match live taxonomy and seqs reconstruct from append order", async () => {
  const h = harness();
  try {
    h.runLog.append("fl-r", { type: "run:meta", runId: "fl-r", agent: "scout", model: "m", task: "t", startedAt: 1, track: false, todoId: null });
    h.runLog.append("fl-r", { type: "message", role: "assistant", text: "one", turnIndex: 0 });
    h.runLog.append("fl-r", { type: "tool", toolName: "read", args: "a.ts", result: "body", isError: false, turnIndex: 0 });
    h.runLog.append("fl-r", { type: "run:ended", runId: "fl-r", status: "completed", endedAt: 9, tokenTotal: 3 });
    const child = await h.server.handle({ id: "o1", verb: "observe", params: { runId: "fl-r", tier: "child" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.deepEqual(child.data.events.map((e) => e.channel), ["fleet:child:message", "fleet:child:tool"]);
    assert.deepEqual(child.data.events.map((e) => e.payload.seq), [2, 3], "seq = position in the FULL RunLog list (dense, like the live bus)");
    const life = await h.server.handle({ id: "o2", verb: "observe", params: { runId: "fl-r", tier: "lifecycle" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.deepEqual(life.data.events.map((e) => e.channel), ["fleet:run:started", "fleet:run:ended"]);
    assert.deepEqual(life.data.events.map((e) => e.payload.seq), [1, 4], "dense seqs — run:ended is position 4 of 4");
    assert.equal(life.data.events[1]!.payload.status, "completed");
    const nf = await h.server.handle({ id: "o3", verb: "observe", params: { runId: "fl-absent" } });
    assert.equal((nf as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("steer/abort: session-handle mapping (not-found / finished / unsupported / ok)", async () => {
  const h = harness();
  try {
    const steered: string[] = [];
    const aborted: string[] = [];
    h.registry.add(record({ runId: "fl-live", session: {
      steer: async (t: string) => { steered.push(t); },
      abort: async () => { aborted.push("x"); },
      get supportsSteer() { return true; },
    } as never }));
    h.registry.add(record({ runId: "fl-claude", session: {
      steer: async () => { throw new Error("steer not supported on this backend"); },
      abort: async () => {},
      get supportsSteer() { return false; },
    } as never }));
    h.registry.add(record({ runId: "fl-done", status: "completed", endedAt: 2 }));

    const nf = await h.server.handle({ id: "g1", verb: "steer", params: { runId: "fl-absent", message: "m" } });
    assert.equal((nf as { error: { code: string } }).error.code, "E-RUN-NOT-FOUND");
    const fin = await h.server.handle({ id: "g2", verb: "abort", params: { runId: "fl-done" } });
    assert.equal((fin as { error: { code: string } }).error.code, "E-RUN-FINISHED");
    const unsup = await h.server.handle({ id: "g3", verb: "steer", params: { runId: "fl-claude", message: "m" } });
    assert.equal((unsup as { error: { code: string } }).error.code, "E-STEER-UNSUPPORTED");
    const okSteer = await h.server.handle({ id: "g4", verb: "steer", params: { runId: "fl-live", message: "pivot" } });
    assert.equal((okSteer as { ok: boolean }).ok, true);
    assert.deepEqual(steered, ["pivot"], "steer reached the live handle");
    const okAbort = await h.server.handle({ id: "g5", verb: "abort", params: { runId: "fl-live" } });
    assert.equal((okAbort as { ok: boolean }).ok, true);
    assert.deepEqual(aborted, ["x"], "abort reached the live handle");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("observe replay seqs match live FleetEventBus envelopes (dedupe contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-rpc-parity-"));
  try {
    const runLog = new RunLog(join(dir, "conversations"));
    const journal = new RunJournal(join(dir, "runs"));
    const live: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const bus = new FleetEventBus({
      runLog, journal,
      emit: (channel, payload) => live.push({ channel, payload: payload as Record<string, unknown> }),
    });
    // Interleaved journal appends prove seq is PER STORE, not global append position.
    // Journal bookends + a checkpoint: real lifecycle runs always bookend the journal with
    // run:started / run:completed — the replay layer must count PHASE events only, or the
    // seqs overshoot by the number of bookends (the bug this pins).
    journal.append("fl-p", { type: "run:started", runId: "fl-p", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
    runLog.append("fl-p", { type: "run:meta", runId: "fl-p", agent: "scout", model: "m", task: "t", startedAt: 1000, track: false, todoId: null });
    runLog.append("fl-p", { type: "message", role: "assistant", text: "one", turnIndex: 0 });
    journal.append("fl-p", { type: "phase:started", phase: "impl", ts: 2 });
    runLog.append("fl-p", { type: "tool", toolName: "read", args: "a.ts", result: "body", isError: false, turnIndex: 0 });
    journal.append("fl-p", { type: "checkpoint", phase: "impl", decision: "continue", ts: 3 });
    journal.append("fl-p", { type: "phase:completed", phase: "impl", summary: "did", paths: ["a.ts"], ts: 4 });
    runLog.append("fl-p", { type: "run:ended", runId: "fl-p", status: "completed", endedAt: 2500, tokenTotal: 3 });
    journal.append("fl-p", { type: "run:completed", runId: "fl-p", ts: 5 });
    bus.dispose();

    // Live phase envelopes: exactly seq 1 and 2 (the bus counts PHASE events only).
    const livePhase = live.filter((e) => e.channel.startsWith("fleet:phase:"));
    assert.deepEqual(livePhase.map((e) => e.payload.seq), [1, 2], "live bus phase seqs");
    assert.equal(live.filter((e) => !e.channel.startsWith("fleet:phase:")).length, 4, "RunLog-derived envelopes: run:started/ended + child:message/tool");

    const server = new RpcServer({
      runRegistry: new RunRegistry(), runLog: new RunLog(join(dir, "conversations")),
      journal: new RunJournal(join(dir, "runs")),
      parentCwd: dir, hasAsyncRunner: false, spawn: () => {},
    }, () => true);
    const reply = await server.handle({ id: "p1", verb: "observe", params: { runId: "fl-p", tier: "both" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.equal(reply.ok, true);

    // THE CONTRACT: for every live-emitted channel, the replay payload seq equals the
    // live envelope seq — a live→replay subscriber dedupes by (channel, runId, seq).
    for (const env of live) {
      const match = reply.data.events.find((e) => e.channel === env.channel);
      assert.ok(match, `replay missing channel ${env.channel}`);
      assert.equal(match.payload.seq, env.payload.seq, `seq parity broken for ${env.channel} (live ${env.payload.seq}, replay ${match.payload.seq})`);
    }
    assert.equal(live.length, 6, "sanity: 4 RunLog-derived + 2 journal-derived envelopes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a handler exception → E-INTERNAL, never a thrown reply (one reply per request)", async () => {
  const h = harness();
  try {
    const throwing = new RpcServer({
      ...h.deps,
      runRegistry: { get: () => { throw new Error("boom"); }, list: () => [] },
    } as never, () => true);
    const r = await throwing.handle({ id: "z1", verb: "status", params: { runId: "fl-x" } });
    assert.equal((r as { error: { code: string } }).error.code, "E-INTERNAL");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

// #84: typed steer/abort rejections — the verb maps on the error TYPE first (the string
// matching stays as a back-compat fallback for third-party session handles).
test("#84: typed SessionRejectionError maps by reason, message text irrelevant", async () => {
  const h = harness();
  try {
    h.registry.add(record({ runId: "fl-typed-unsup", session: {
      steer: async () => { throw new SessionRejectionError("steer-unsupported", "completely different wording"); },
      abort: async () => {},
      get supportsSteer() { return true; }, // flag true but the call rejects — the race fallback
    } as never }));
    h.registry.add(record({ runId: "fl-typed-already", session: {
      steer: async () => {},
      abort: async () => { throw new SessionRejectionError("already-aborted", "also different wording"); },
      get supportsSteer() { return true; },
    } as never }));
    const unsup = await h.server.handle({ id: "t1", verb: "steer", params: { runId: "fl-typed-unsup", message: "m" } });
    assert.equal((unsup as { error: { code: string } }).error.code, "E-STEER-UNSUPPORTED", "typed reason wins over message text");
    const already = await h.server.handle({ id: "t2", verb: "abort", params: { runId: "fl-typed-already" } });
    assert.equal((already as { error: { code: string } }).error.code, "E-RUN-FINISHED", "typed already-aborted → E-RUN-FINISHED");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("#84: string-matched rejections (third-party handles) still map — back-compat fallback", async () => {
  const h = harness();
  try {
    h.registry.add(record({ runId: "fl-str-unsup", session: {
      steer: async () => { throw new Error("steer not supported on this backend"); },
      abort: async () => {},
      get supportsSteer() { return true; },
    } as never }));
    h.registry.add(record({ runId: "fl-str-already", session: {
      steer: async () => {},
      abort: async () => { throw new Error("run already aborted"); },
      get supportsSteer() { return true; },
    } as never }));
    const unsup = await h.server.handle({ id: "s1", verb: "steer", params: { runId: "fl-str-unsup", message: "m" } });
    assert.equal((unsup as { error: { code: string } }).error.code, "E-STEER-UNSUPPORTED");
    const already = await h.server.handle({ id: "s2", verb: "abort", params: { runId: "fl-str-already" } });
    assert.equal((already as { error: { code: string } }).error.code, "E-RUN-FINISHED");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("#84: status list past LIST_CAP carries a truncated count; at/below cap does not", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 28; i++) {
      h.registry.add(record({ runId: `fl-cap-${i}`, task: `t${i}` }));
    }
    const r = await h.server.handle({ id: "c1", verb: "status", params: {} }) as { ok: true; data: { runs: unknown[]; truncated?: number } };
    assert.equal(r.ok, true);
    assert.equal(r.data.runs.length, 25, "LIST_CAP still caps the list");
    assert.equal(r.data.truncated, 3, "truncated names the omitted count");

    h.registry.add(record({ runId: "fl-cap-99", task: "one more" })); // 29 total → 25 + 4
    const r2 = await h.server.handle({ id: "c2", verb: "status", params: {} }) as { ok: true; data: { truncated?: number } };
    assert.equal(r2.data.truncated, 4);

    const empty = await h.server.handle({ id: "c3", verb: "status", params: { runId: "fl-cap-0" } }) as { ok: true; data: Record<string, unknown> };
    assert.equal(empty.ok, true);
    assert.equal("truncated" in empty.data, false, "single-run lookup never carries truncated");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("#84: exactly-at-LIST_CAP → truncated absent (boundary pin, review NIT 5)", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 25; i++) h.registry.add(record({ runId: `fl-edge-${i}` }));
    const r = await h.server.handle({ id: "e1", verb: "status", params: {} }) as { ok: true; data: { runs: unknown[]; truncated?: number } };
    assert.equal(r.data.runs.length, 25);
    assert.equal("truncated" in r.data, false, "at-cap is NOT partial — no marker");
    h.registry.add(record({ runId: "fl-edge-99" })); // 26th
    const r2 = await h.server.handle({ id: "e2", verb: "status", params: {} }) as { ok: true; data: { truncated?: number } };
    assert.equal(r2.data.truncated, 1, "one past the cap → truncated: 1");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("#88: observe replay forwards languageDrift fields on fleet:run:ended", async () => {
  const h = harness();
  try {
    h.runLog.append("fl-dr", { type: "run:meta", runId: "fl-dr", agent: "scout", model: "m", task: "t", startedAt: 1, track: false, todoId: null });
    h.runLog.append("fl-dr", { type: "run:ended", runId: "fl-dr", status: "completed", endedAt: 9, tokenTotal: 3, languageDrift: true, languageDriftRatio: 0.55 });
    const life = await h.server.handle({ id: "od1", verb: "observe", params: { runId: "fl-dr", tier: "lifecycle" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    const ended = life.data.events.find((e) => e.channel === "fleet:run:ended");
    assert.ok(ended, "run:ended replayed");
    assert.equal(ended!.payload.languageDrift, true);
    assert.equal(ended!.payload.languageDriftRatio, 0.55);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
