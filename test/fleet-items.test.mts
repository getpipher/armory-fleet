// test/fleet-items.test.mts
// SPEC-5a proper-fix: the fleet-tab list merges foreground (RunRegistry) rows
// and live bg (BgRunsStore) rows, deduping by runId.
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { buildFleetItems } from "../src/panel/fleet-items.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { BgRunsStore } from "../src/panel/bg-runs-store.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const bgRow = (over: Partial<BgRunStatus> = {}): BgRunStatus => ({
  runId: "fl-bg1", lifecycle: "default", status: "running", phase: "implement",
  phaseIndex: 2, phaseTotal: 5, mode: "auto", backend: "pi", task: "bg task", ...over,
});

test("empty registries → empty list", () => {
  const items = buildFleetItems({ runRegistry: new RunRegistry() });
  strictEqual(items.length, 0);
});

test("foreground-only: renders fleetRow for each RunRecord", () => {
  const rr = new RunRegistry();
  rr.add({ runId: "fl-fg1", agent: "coder", model: "m", task: "do thing", track: true, todoId: null, status: "running", startedAt: 2 , cwd: "/", backend: "pi"});
  rr.add({ runId: "fl-fg2", agent: "coder", model: "m", task: "other", track: true, todoId: null, status: "completed", startedAt: 1, endedAt: 9 , cwd: "/", backend: "pi"});
  const items = buildFleetItems({ runRegistry: rr });
  strictEqual(items.length, 2);
  // newest-first (RunRegistry.list sorts by startedAt desc)
  strictEqual(items[0]!.value, "fl-fg1");
  ok(items[0]!.label.includes("fl-fg1"));
  ok(items[1]!.label.includes("fl-fg2"));
});

test("bg-only: renders renderBgRow for each BgRunStatus", () => {
  const rr = new RunRegistry();
  const bg = new BgRunsStore();
  bg.set("fl-bg1", bgRow({ runId: "fl-bg1", status: "running", phase: "plan", phaseIndex: 1, phaseTotal: 4 }));
  bg.set("fl-bg2", bgRow({ runId: "fl-bg2", status: "completed", phase: "finish", phaseIndex: 4, phaseTotal: 4, branch: "fleet/fl-bg2" }));
  const items = buildFleetItems({ runRegistry: rr, bgRuns: bg });
  strictEqual(items.length, 2);
  ok(items[0]!.label.includes("▶") || items[0]!.label.includes("✓"));
  ok(items.some((i) => i.label.includes("fl-bg1")));
  ok(items.some((i) => i.label.includes("fl-bg2")));
});

test("merge: foreground + bg rows both appear", () => {
  const rr = new RunRegistry();
  rr.add({ runId: "fl-fg1", agent: "coder", model: "m", task: "fg", track: true, todoId: null, status: "running", startedAt: 1 , cwd: "/", backend: "pi"});
  const bg = new BgRunsStore();
  bg.set("fl-bg1", bgRow({ runId: "fl-bg1" }));
  const items = buildFleetItems({ runRegistry: rr, bgRuns: bg });
  strictEqual(items.length, 2);
  ok(items.some((i) => i.value === "fl-fg1"));
  ok(items.some((i) => i.value === "fl-bg1"));
});

test("dedup: a runId present in both stores appears once (foreground wins)", () => {
  const rr = new RunRegistry();
  rr.add({ runId: "fl-dup", agent: "coder", model: "m", task: "fg", track: true, todoId: null, status: "completed", startedAt: 1, endedAt: 5 , cwd: "/", backend: "pi"});
  const bg = new BgRunsStore();
  bg.set("fl-dup", bgRow({ runId: "fl-dup", status: "running" }));
  const items = buildFleetItems({ runRegistry: rr, bgRuns: bg });
  strictEqual(items.length, 1, "deduped to one row");
  // foreground label uses fleetRow (✓ for completed); bg running label uses ▶
  ok(items[0]!.label.includes("✓"), "foreground row wins on dedup");
});