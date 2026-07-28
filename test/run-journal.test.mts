// test/run-journal.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunJournal } from "../src/runtime/run-journal.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "journal-test-"));
}

test("append writes one JSON line per event; replay reconstructs them in order", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-1", { type: "run:started", runId: "fl-1", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-1" }, mode: "auto", ts: 1 });
  j.append("fl-1", { type: "phase:started", phase: "brainstorm", ts: 2 });
  j.append("fl-1", { type: "phase:completed", phase: "brainstorm", summary: "s", paths: ["a.md"], ts: 3 });
  const events = j.replay("fl-1");
  assert.equal(events.length, 3);
  assert.equal(events[0]!.type, "run:started");
  assert.equal((events[2] as any).paths.join(), "a.md");
  rmSync(dir, { recursive: true, force: true });
});

test("replay skips a partial (incomplete) last line", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-2", { type: "run:started", runId: "fl-2", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-2" }, mode: "auto", ts: 1 });
  const file = join(dir, "fl-2.jsonl");
  const existing = readFileSync(file, "utf8");
  writeFileSync(file, existing + '{"type":"phase:started","phase":"brain","ts":2'); // no newline, incomplete
  const events = j.replay("fl-2");
  assert.equal(events.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("scanNonTerminal returns runs whose journal has no terminal event", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-3", { type: "run:started", runId: "fl-3", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-3" }, mode: "auto", ts: 1 });
  j.append("fl-3", { type: "run:completed", runId: "fl-3", branch: "fleet/fl-3", ts: 2 });
  j.append("fl-4", { type: "run:started", runId: "fl-4", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-4" }, mode: "auto", ts: 1 });
  j.append("fl-4", { type: "phase:started", phase: "brainstorm", ts: 2 });
  j.append("fl-5", { type: "run:started", runId: "fl-5", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-5" }, mode: "auto", ts: 1 });
  j.append("fl-5", { type: "run:aborted", runId: "fl-5", reason: "user-abort", ts: 2 });
  const nonTerminal = j.scanNonTerminal().sort();
  assert.deepEqual(nonTerminal, ["fl-4"]);
  rmSync(dir, { recursive: true, force: true });
});

test("run:started without worktree + run:completed without branch round-trip", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-ip1", { type: "run:started", runId: "fl-ip1", task: "t", lifecycle: "default", mode: "auto", ts: 1 });
  j.append("fl-ip1", { type: "run:completed", runId: "fl-ip1", ts: 2 });
  const events = j.replay("fl-ip1");
  assert.equal(events.length, 2);
  const started = events[0] as any;
  assert.equal(started.worktree, undefined);
  const completed = events[1] as any;
  assert.equal(completed.branch, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("old run:started with worktree still parses after the field becomes optional", () => {
  const dir = makeDir();
  const j = new RunJournal(dir);
  j.append("fl-old", { type: "run:started", runId: "fl-old", task: "t", lifecycle: "default", worktree: { path: "/x", branch: "fleet/fl-old" }, mode: "auto", ts: 1 });
  const events = j.replay("fl-old");
  assert.equal((events[0] as any).worktree.branch, "fleet/fl-old");
  rmSync(dir, { recursive: true, force: true });
});