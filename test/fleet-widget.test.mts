// test/fleet-widget.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { FleetWidgetController } from "../src/panel/fleet-widget.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { BgRunsStore } from "../src/panel/bg-runs-store.ts";
import type { BgRunStatus } from "../src/panel/rows.ts";

const bgRow = (over: Partial<BgRunStatus> = {}): BgRunStatus => ({
  runId: "fl-bg1", lifecycle: "default", status: "running", phase: "implement",
  phaseIndex: 2, phaseTotal: 5, mode: "auto", backend: "pi", task: "bg", ...over,
});

/** Records setWidget calls by key. */
function fakeUi() {
  const calls: { key: string; content: string[] | undefined }[] = [];
  return {
    calls,
    ui: {
      setWidget: (key: string, content: string[] | undefined, _opts?: { placement?: string }) => {
        calls.push({ key, content });
      },
    },
  };
}

test("active fg run → both widgets set; completion → both cleared", () => {
  const rr = new RunRegistry();
  const { calls, ui } = fakeUi();
  let now = 5000;
  const c = new FleetWidgetController({
    runRegistry: rr, ui, getTheme: () => ({}) as any,
    now: () => now,
    setInterval: () => 123 as any, clearInterval: () => {},
  });
  c.start();

  rr.add({ runId: "fl-1", agent: "coder", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 1000 });
  const lastActive = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  const lastView = calls.filter((c2) => c2.key === "fleet-view").at(-1)!;
  ok(lastActive.content!.length === 1 && lastActive.content![0]!.includes("fl-1"), "above widget shows the run");
  ok(lastView.content!.length === 1, "below widget shows the run");

  rr.update("fl-1", { status: "completed", endedAt: now });
  const after = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  strictEqual(after.content, undefined, "above widget cleared on completion");
  const afterView = calls.filter((c2) => c2.key === "fleet-view").at(-1)!;
  strictEqual(afterView.content, undefined, "below widget cleared on completion");
  c.dispose();
});

test("bg run active → widget shows bg row with phase; cleared on completion", () => {
  const rr = new RunRegistry();
  const bg = new BgRunsStore();
  const { calls, ui } = fakeUi();
  const c = new FleetWidgetController({ runRegistry: rr, bgRuns: bg, ui, getTheme: () => ({}) as any, now: () => 1000 });
  c.start();
  bg.set("fl-bg1", bgRow({ phase: "plan", phaseIndex: 1, phaseTotal: 4 }));
  const last = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  ok(last.content![0]!.includes("●plan 1/4"), "bg phase segment shown");
  bg.set("fl-bg1", bgRow({ status: "completed", phase: "finish", phaseIndex: 4, phaseTotal: 4 }));
  const after = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  strictEqual(after.content, undefined, "cleared when bg completes");
  c.dispose();
});

test("timer tick re-renders with updated live duration", () => {
  const rr = new RunRegistry();
  const { calls, ui } = fakeUi();
  let now = 3000;
  let tickFn: (() => void) | null = null;
  const c = new FleetWidgetController({
    runRegistry: rr, ui, getTheme: () => ({}) as any,
    now: () => now,
    setInterval: (fn) => { tickFn = fn; return 1 as any; }, clearInterval: () => {},
  });
  c.start();
  rr.add({ runId: "fl-1", agent: "coder", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 0 });
  const before = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  ok(before.content![0]!.includes("3s"), `duration at now=3000: ${before.content![0]}`);

  now = 4000;
  tickFn!(); // simulate the 1s timer firing
  const after = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  ok(after.content![0]!.includes("4s"), `duration ticked to 4s: ${after.content![0]}`);
  c.dispose();
});

test("dispose clears timer + both widgets + is idempotent", () => {
  const rr = new RunRegistry();
  const { calls, ui } = fakeUi();
  let cleared = 0;
  const c = new FleetWidgetController({
    runRegistry: rr, ui, getTheme: () => ({}) as any, now: () => 0,
    setInterval: () => 7 as any, clearInterval: () => { cleared++; },
  });
  c.start();
  rr.add({ runId: "fl-1", agent: "a", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 0 });
  c.dispose();
  const lastActive = calls.filter((c2) => c2.key === "fleet-active").at(-1)!;
  strictEqual(lastActive.content, undefined, "cleared on dispose");
  ok(cleared >= 1, "timer cleared on dispose");
  const callsBefore = calls.length;
  c.dispose(); // idempotent — no further setWidget calls
  strictEqual(calls.length, callsBefore, "second dispose is a no-op");
});

test("store emits after dispose are no-op (disposed guard)", () => {
  const rr = new RunRegistry();
  const { calls, ui } = fakeUi();
  const c = new FleetWidgetController({ runRegistry: rr, ui, getTheme: () => ({}) as any, now: () => 0 });
  c.start();
  c.dispose();
  const callsBefore = calls.length;
  rr.add({ runId: "fl-1", agent: "a", model: "m", task: "t", track: true, todoId: null, status: "running", startedAt: 0 });
  strictEqual(calls.length, callsBefore, "no render after dispose");
});