// test/live-timeline.test.mts — SPEC-6-4 Task 6: tail-follow state machine (pure logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveTimelineState } from "../src/panel/live-timeline.ts";

test("starts pinned at index 0", () => {
  const s = new LiveTimelineState();
  assert.equal(s.index, 0);
  assert.equal(s.pinned, true);
});

test("append keeps the cursor on the newest row while pinned", () => {
  const s = new LiveTimelineState();
  s.onKey("down", 1);          // index 0 → pinned (only row)
  assert.equal(s.append(2), 1, "cursor rides to the new last row");
  assert.equal(s.append(3), 2);
});

test("up unpins; append then leaves the cursor alone", () => {
  const s = new LiveTimelineState();
  s.append(3);                 // pinned at 2
  assert.equal(s.onKey("up", 3), true);
  assert.equal(s.index, 1);
  assert.equal(s.pinned, false);
  assert.equal(s.append(4), 1, "unpinned cursor does not move");
});

test("down re-pins only at the last row", () => {
  const s = new LiveTimelineState();
  s.append(4);                 // pinned at 3
  s.onKey("up", 4);            // 2, unpinned
  s.onKey("up", 4);            // 1, mid-list
  assert.equal(s.onKey("down", 4), true);
  assert.equal(s.index, 2);
  assert.equal(s.pinned, false, "mid-list down is not pinned");
  assert.equal(s.onKey("down", 4), true);
  assert.equal(s.index, 3);
  assert.equal(s.pinned, true, "reaching the last row re-pins");
  assert.equal(s.append(5), 4, "pinned again — rides new rows");
});

test("cursor never leaves [0, total-1]", () => {
  const s = new LiveTimelineState();
  assert.equal(s.onKey("up", 1), false, "up at top is a no-op");
  s.append(2);
  assert.equal(s.onKey("down", 2), false, "down at bottom is a no-op");
});

test("empty list: keys are no-ops", () => {
  const s = new LiveTimelineState();
  assert.equal(s.onKey("up", 0), false);
  assert.equal(s.onKey("down", 0), false);
});
