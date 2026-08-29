// test/rpc-server.test.mts — SPEC-6-4 Task 4: RPC verbs, gate, error codes (frozen surface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog } from "../src/runtime/run-log.ts";
import { RunJournal } from "../src/runtime/run-journal.ts";
import { RunRegistry, type RunRecord } from "../src/engine/run-registry.ts";
import { RpcServer, rpcControlEnabled } from "../src/rpc/rpc-server.ts";

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
    const life = await h.server.handle({ id: "s3", verb: "spawn", params: { agent: "a", task: "t", lifecycle: "default" } });
    assert.equal((life as { error: { code: string } }).error.code, "E-BAD-PARAMS", "lifecycle over RPC is deferred (spec §7)");
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
    assert.deepEqual(child.data.events.map((e) => e.payload.seq), [1, 2], "seq reconstructs from RunLog append order");
    const life = await h.server.handle({ id: "o2", verb: "observe", params: { runId: "fl-r", tier: "lifecycle" } }) as { ok: true; data: { events: Array<{ channel: string; payload: Record<string, unknown> }> } };
    assert.deepEqual(life.data.events.map((e) => e.channel), ["fleet:run:started", "fleet:run:ended"]);
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
