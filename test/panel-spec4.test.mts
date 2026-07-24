import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { lifecycleRow, lifecyclePhaseTimeline } from "../src/panel/rows.ts";
import type { LifecycleRunRecord } from "../src/lifecycle/lifecycle-types.ts";

const run = (over: Partial<LifecycleRunRecord> = {}): LifecycleRunRecord => ({
  runId: "fl-2kp9xa", lifecycleName: "default", task: "implement feature X", backend: "pi",
  mode: "checkpointed", status: "checkpoint", phases: [
    { name: "brainstorm", summary: "design", paths: ["a.md"], status: "completed", reviseCount: 0 },
    { name: "plan", summary: "plan", paths: ["b.md"], status: "completed", reviseCount: 0 },
    { name: "implement", summary: "code", paths: ["c.ts"], status: "completed", reviseCount: 1 },
    { name: "review", summary: "review", paths: ["r.md"], status: "completed", reviseCount: 0 },
    { name: "finish", summary: "", paths: [], status: "running", reviseCount: 0 },
  ],
  startedAt: 1000, endedAt: 61000, todoId: "td-1", ...over,
});

test("lifecycleRow renders status glyph + id + lifecycle + current phase + counts + mode + backend + task", () => {
  const row = lifecycleRow(run());
  ok(row.startsWith("⏸ fl-2kp9xa"));
  ok(row.includes("default"));
  ok(row.includes("●finish"));
  ok(row.includes("5/5"));
  ok(row.includes("checkpointed"));
  ok(row.includes("pi"));
  ok(row.includes("implement feature X"));
});

test("lifecycleRow uses ▶ for running, ✓ for completed, ✗ for failed/aborted", () => {
  ok(lifecycleRow(run({ status: "running" })).startsWith("▶"));
  ok(lifecycleRow(run({ status: "completed" })).startsWith("✓"));
  ok(lifecycleRow(run({ status: "failed" })).startsWith("✗"));
  ok(lifecycleRow(run({ status: "aborted" })).startsWith("✗"));
});

test("lifecyclePhaseTimeline renders [x]/[~]/[ ] markers + artifact paths", () => {
  const tl = lifecyclePhaseTimeline(run());
  ok(tl.includes("[x] brainstorm"), "completed → [x]");
  ok(tl.includes("[~] implement"), "revised → [~]");
  ok(tl.includes("a.md"), "artifact path surfaced");
});

test("lifecyclePhaseTimeline shows the checkpoint prompt when status is checkpoint", () => {
  const tl = lifecyclePhaseTimeline(run({ status: "checkpoint" }));
  ok(/Continue|Revise|Abort/i.test(tl), "checkpoint actions present");
});