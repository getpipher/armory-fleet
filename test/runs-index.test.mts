// test/runs-index.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLog } from "../src/runtime/run-log.ts";
import { buildRunsIndex } from "../src/panel/runs-index.ts";

function makeDir(): string { return mkdtempSync(join(tmpdir(), "runs-index-")); }

test("buildRunsIndex returns newest-first by startedAt", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-old", { type: "run:meta", runId: "fl-old", agent: "g", model: "m", task: "a", startedAt: 10, track: true, todoId: null });
  log.append("fl-new", { type: "run:meta", runId: "fl-new", agent: "g", model: "m", task: "b", startedAt: 90, track: true, todoId: null });
  log.append("fl-mid", { type: "run:meta", runId: "fl-mid", agent: "g", model: "m", task: "c", startedAt: 50, track: true, todoId: null });
  const list = buildRunsIndex(dir);
  assert.deepEqual(list.map((r) => r.runId), ["fl-new", "fl-mid", "fl-old"]);
  rmSync(dir, { recursive: true, force: true });
});

test("buildRunsIndex returns [] when dir missing", () => {
  assert.deepEqual(buildRunsIndex(join(tmpdir(), "no-such-dir-xyz")), []);
});

test("buildRunsIndex preserves provenance from run:ended", () => {
  const dir = makeDir();
  const log = new RunLog(dir);
  log.append("fl-x", { type: "run:meta", runId: "fl-x", agent: "g", model: "m", task: "t", startedAt: 1, track: true, todoId: null });
  log.append("fl-x", { type: "run:ended", runId: "fl-x", status: "completed", endedAt: 2, tokenTotal: 0, forkedFrom: "fl-p" });
  assert.equal(buildRunsIndex(dir)[0]!.forkedFrom, "fl-p");
  rmSync(dir, { recursive: true, force: true });
});