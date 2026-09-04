// test/panel-present.test.mts — panel velocity bundle pure helpers (#104).
import { test } from "node:test";
import assert from "node:assert/strict";
import { totalsLine, footerFor, actionsForRun } from "../src/panel/present.ts";
import { totalsHeader, timelineFooter } from "../src/panel/present.ts";
import { visibleWidth } from "../src/present/width.ts";

test("totals: spinner + running/queued/done/failed counts + cost + tok", () => {
  const t = totalsLine(
    [{ status: "running" }, { status: "running" }, { status: "queued" }, { status: "completed" }, { status: "failed" }],
    { costTotal: 1.5, contextTokens: 265_055 }, 0,
  );
  assert.match(t, /[⣾⣽⣻⢿⡿⣟⣯⣷]/);
  assert.ok(t.includes("2 running"));
  assert.ok(t.includes("1 queued"));
  assert.ok(t.includes("✓ 1 done"));
  assert.ok(t.includes("✗ 1 failed"));
  assert.ok(t.includes("$1.50"));
  assert.ok(t.includes("265K tok"));
  assert.ok(t.includes(" · "), "segments joined with ·");
});

test("totals: all-quiet renders the count-only (idle) form; zero cost/tok omitted", () => {
  const idle = totalsLine([], {}, 0);
  assert.match(idle, /[⣾⣽⣻⢿⡿⣟⣯⣷]/);
  assert.ok(idle.includes("idle"));
  assert.ok(!idle.includes("$"));
  const runningOnly = totalsLine([{ status: "running" }], {}, 3);
  assert.ok(runningOnly.includes("1 running"));
  assert.ok(!runningOnly.includes("$") && !runningOnly.includes("tok"));
});

test("footer: browse hints per view keep today's key sets (reformatted key:label)", () => {
  const fleet = footerFor({ view: "fleet", mode: "browse" });
  assert.ok(fleet.includes("r:Run-new") && fleet.includes("s:Steer") && fleet.includes("x:Stop") && fleet.includes("o:Open-todo") && fleet.includes("q:Quit"));
  const lc = footerFor({ view: "lifecycle", mode: "browse" });
  assert.ok(lc.includes("r:Run-lifecycle") && lc.includes("tab:Runs"));
  const runs = footerFor({ view: "runs", mode: "browse" });
  assert.ok(runs.includes("enter:Replay") && runs.includes("r:Resume") && runs.includes("f:Fork"));
  const wf = footerFor({ view: "workflows", mode: "browse" });
  assert.ok(wf.includes("x:Stop") && wf.includes("s:Save-as"));
  const backends = footerFor({ view: "backends", mode: "browse" });
  assert.ok(backends.includes("r:Refresh") && backends.includes("tab:Fleet"));
});

test("footer: fleet row-selected adds capability segments per status", () => {
  const run = footerFor({ view: "fleet", mode: "row-selected", running: true, canSteer: true });
  assert.ok(run.includes("enter:Full-message") && run.includes("s:Steer") && run.includes("x:Stop"));
  const noSteer = footerFor({ view: "fleet", mode: "row-selected", running: true, canSteer: false });
  assert.ok(noSteer.includes("x:Stop") && !noSteer.includes("s:Steer"));
  const aborted = footerFor({ view: "fleet", mode: "row-selected", aborted: true });
  assert.ok(aborted.includes("↻:Re-run") && !aborted.includes("x:Stop"));
  const paused = footerFor({ view: "fleet", mode: "row-selected", paused: true });
  assert.ok(paused.includes("u:Resume"));
  const plain = footerFor({ view: "fleet", mode: "row-selected" });
  assert.ok(plain.includes("enter:Full-message") && !plain.includes("x:Stop"));
});

test("footer: modal / checkpoint / input / non-fleet row-selected modes", () => {
  assert.equal(footerFor({ view: "fleet", mode: "modal" }), "esc:Back");
  assert.equal(footerFor({ view: "fleet", mode: "checkpoint" }), "c:Continue · v:Revise · a:Abort");
  assert.equal(footerFor({ view: "fleet", mode: "input" }), "enter:Submit-feedback · esc:Cancel");
  assert.equal(footerFor({ view: "runs", mode: "row-selected" }), "enter:Full-message · esc:Back");
  assert.equal(footerFor({ view: "lifecycle", mode: "row-selected" }), "v:View-evidence · g:Re-run-gate · esc:Back");
});

test("actionsForRun capability table", () => {
  assert.deepEqual(actionsForRun("running"), [{ key: "s", label: "steer" }, { key: "x", label: "stop" }]);
  assert.deepEqual(actionsForRun("paused"), [{ key: "u", label: "resume" }]);
  assert.deepEqual(actionsForRun("aborted"), [{ key: "R", label: "re-run" }]);
  assert.deepEqual(actionsForRun("failed"), [{ key: "R", label: "re-run" }]);
  assert.deepEqual(actionsForRun("completed"), []);
  assert.deepEqual(actionsForRun("queued"), []);
});

test("totalsHeader right-aligns totals at the real terminal width", () => {
  const line = totalsHeader("  FLEET  [fleet]", "⣾ 2 running · $0.94", 120);
  assert.equal(visibleWidth(line), 120);
});

test("totalsHeader floors at 40 and never returns negative padding", () => {
  assert.equal(visibleWidth(totalsHeader("  FLEET", "⣾ idle", 10)), 40);
  const big = totalsHeader("  FLEET", "x".repeat(200), 40);
  assert.ok(visibleWidth(big) >= 40);
});

test("timelineFooter: detached shows scroll marker + ↓ re-follow; attached keeps hints", () => {
  assert.equal(timelineFooter(true), "  ↑ scrolled · live paused · ↓ end to re-follow");
  assert.equal(timelineFooter(false), "  enter:Full-message  esc:Back");
});
