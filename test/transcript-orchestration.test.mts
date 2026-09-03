// test/transcript-orchestration.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrationLines } from "../src/transcript/orchestration.ts";

test("waiting-on tree + TODO projection + gate line", () => {
  const runs = [
    { runId: "a", agent: "reviewer", model: "m", task: "t", status: "running", startedAt: 0, lastEventClass: "tool:read", contextTokens: 100, maxContext: 1000 },
    { runId: "b", agent: "scheduler", model: "m", task: "t", status: "queued", startedAt: 0 },
  ] as never[];
  const todos = [
    { id: "1", title: "totals header", status: "done", runId: "a" },
    { id: "2", title: "state footer", status: "in_progress", runId: "b" },
    { id: "3", title: "lineage tree", status: "open", runId: null },
  ];
  const lines = orchestrationLines(runs, todos, "review-pass", 41_000);
  const joined = lines.join("\n");
  // Spinner frame is derived from `now` (120ms ticks — 41s ⇒ frame 341 ⇒ ⣟), so pin the
  // spinner GLYPH CLASS rather than one frame; ⣾ was the brief's over-specific pin.
  assert.match(joined, /[⣾⣽⣻⢿⡿⣟⣯⣷]/);
  assert.ok(joined.includes("reviewer"));
  assert.ok(joined.includes("TODO"));
  assert.ok(joined.includes("☑") && joined.includes("totals header"));
  assert.ok(joined.includes("☐") && joined.includes("lineage tree"));
  assert.ok(joined.includes("review-pass"));
});

test("idle hides nothing here, but empty inputs render only the header — gate absent omits the line", () => {
  const lines = orchestrationLines([], [], undefined, 41_000);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("0 runs"));
  assert.ok(!lines.join("\n").includes("waiting on gate"));
});
