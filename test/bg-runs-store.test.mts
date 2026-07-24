// test/bg-runs-store.test.mts
// SPEC-5a proper-fix: BgRunsStore is a change-emitting store backing the /fleet fleet-tab bg rows.
// Replaces the bare `Map<string, BgRunStatus>` so the panel can subscribe to mid-run mutations
// (onProgress / completion) and re-render without a keypress.
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { BgRunsStore } from "../src/panel/bg-runs-store.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const row = (over: Partial<BgRunStatus> = {}): BgRunStatus => ({
  runId: "fl-1", lifecycle: "default", status: "running", phase: "implement",
  phaseIndex: 2, phaseTotal: 5, mode: "auto", backend: "pi", task: "t", ...over,
});

test("set + get round-trips a BgRunStatus", () => {
  const s = new BgRunsStore();
  s.set("fl-1", row());
  strictEqual(s.get("fl-1")!.runId, "fl-1");
});

test("values iterates the stored rows", () => {
  const s = new BgRunsStore();
  s.set("fl-1", row({ runId: "fl-1" }));
  s.set("fl-2", row({ runId: "fl-2" }));
  strictEqual([...s.values()].length, 2);
});

test("set fires subscribers with the runId", () => {
  const s = new BgRunsStore();
  const calls: string[] = [];
  const unsub = s.subscribe((runId) => calls.push(runId));
  s.set("fl-1", row({ runId: "fl-1" }));
  strictEqual(calls.length, 1);
  strictEqual(calls[0], "fl-1");
  // updating an existing run fires again (status transition running → completed)
  s.set("fl-1", row({ runId: "fl-1", status: "completed" }));
  strictEqual(calls.length, 2);
  unsub();
});

test("unsubscribe stops further notifications", () => {
  const s = new BgRunsStore();
  const calls: string[] = [];
  const unsub = s.subscribe((runId) => calls.push(runId));
  unsub();
  s.set("fl-1", row());
  strictEqual(calls.length, 0);
});

test("multiple subscribers all fire", () => {
  const s = new BgRunsStore();
  const a: string[] = [];
  const b: string[] = [];
  const u1 = s.subscribe((id) => a.push(id));
  const u2 = s.subscribe((id) => b.push(id));
  s.set("fl-1", row({ runId: "fl-1" }));
  strictEqual(a.length, 1);
  strictEqual(b.length, 1);
  u1();
  s.set("fl-2", row({ runId: "fl-2" }));
  strictEqual(a.length, 1);
  strictEqual(b.length, 2);
  u2();
});