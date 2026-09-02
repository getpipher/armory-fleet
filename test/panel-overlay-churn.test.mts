// test/panel-overlay-churn.test.mts — #85 part 1: live-append churn under the
// full-message overlay. While the overlay is open on a LIVE timeline, every appended
// event used to rebuild the whole panel (fresh SelectList → scroll/selection reset).
// The overlay's content comes from the stable `fullMessageEvent`, so appends must not
// re-render while it is open. Data currency (runTimeline growth) and tail-follow of
// the timeline itself (overlay closed) are both preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, type MessageEvent } from "../src/runtime/run-log.ts";
import { WorkflowRunStore } from "../src/workflows/runtime/run-store.ts";
import { WorkflowRegistry } from "../src/workflows/registry.ts";
import { FleetPanel } from "../src/panel/fleet-panel.ts";
import { fakeTheme } from "./helpers/workflow-panel-fixture.mts";

const RUN_ID = "fl-churn";

function msg(turnIndex: number, text: string): MessageEvent {
  return { type: "message", role: "assistant", text, turnIndex };
}

function metaEvent() {
  return {
    type: "run:meta" as const, runId: RUN_ID, agent: "scout", model: "test/model",
    task: "churn fixture", startedAt: Date.now(), track: true, todoId: null,
  };
}

interface Panelish {
  handleInput(s: string): void;
  messageBodyList: unknown;
  timelineList: unknown;
  runTimeline: unknown[] | null;
  fullMessageEvent: unknown;
  children: unknown[];
}

function churnPanel(): { panel: FleetPanel; panelish: Panelish; log: RunLog; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "churn-"));
  const log = new RunLog(dir);
  log.append(RUN_ID, metaEvent());
  log.append(RUN_ID, msg(0, "first report"));
  log.append(RUN_ID, msg(1, "second report"));

  const store = new WorkflowRunStore();
  const panel = new FleetPanel({
    theme: fakeTheme(),
    deps: {
      registry: new Map(),
      runRegistry: {
        subscribe: () => () => {},
        get: () => undefined,
        list: () => [],
      } as never,
      lock: { acquire: () => {}, release: () => {} } as never,
      todoSync: {} as never,
      backendRegistry: { list: () => [], get: () => undefined } as never,
      parentModel: { provider: "", id: "" },
      parentCwd: "",
      lifecycleRegistry: new Map(),
      lifecycleRuns: new Map(),
      lifecycleDeps: {} as never,
      workflowController: {} as never,
      workflowStore: store,
      workflowRegistry: new WorkflowRegistry(new Map()),
      runLog: log,
    },
    onDone: () => {},
    onNotify: () => {},
  });
  return {
    panel,
    panelish: panel as unknown as Panelish,
    log,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("#85: live append while full-message overlay is open does NOT rebuild the overlay", () => {
  const { panel, panelish, log, cleanup } = churnPanel();
  try {
    // fleet → lifecycle → runs
    panel.handleInput("\t");
    panel.handleInput("\t");
    // Enter on the run row → live timeline (run:meta only → status running)
    panel.handleInput("\r");
    assert.ok(panelish.timelineList, "timeline list built");
    // Enter on the first timeline event → full-message overlay
    panel.handleInput("\r");
    assert.ok(panelish.fullMessageEvent, "full-message overlay open");
    const overlayBefore = panelish.messageBodyList;
    const childrenBefore = panelish.children.length;
    assert.ok(overlayBefore, "overlay body list captured");

    // A live append arrives while the overlay is open — the churn case.
    log.append(RUN_ID, msg(2, "third report — arrives under the overlay"));

    assert.equal(panelish.messageBodyList, overlayBefore, "overlay body list identity stable (no rebuild)");
    assert.equal(panelish.children.length, childrenBefore, "panel children untouched (no rebuild)");
    // Data currency is preserved even though the render was skipped:
    // runTimeline = replay(meta + 2 msgs) + the appended msg = 4.
    assert.equal(panelish.runTimeline?.length, 4, "runTimeline still grew (meta + 3 messages)");
  } finally {
    cleanup();
  }
});

test("#85: live append with overlay CLOSED still tail-follows (timeline re-renders)", () => {
  const { panel, panelish, log, cleanup } = churnPanel();
  try {
    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\r"); // live timeline
    assert.ok(panelish.timelineList, "timeline list built");
    assert.equal(panelish.fullMessageEvent, null, "no overlay");
    const tlBefore = panelish.timelineList;

    log.append(RUN_ID, msg(2, "third report — overlay closed, tail-follow must work"));

    assert.notEqual(panelish.timelineList, tlBefore, "timeline rebuilt on append (tail-follow preserved)");
    assert.equal(panelish.runTimeline?.length, 4, "timeline grew (meta + 3 messages)");
  } finally {
    cleanup();
  }
});

test("#85: closing the overlay re-renders and picks up events appended underneath", () => {
  const { panel, panelish, log, cleanup } = churnPanel();
  try {
    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\r"); // timeline
    panel.handleInput("\r"); // overlay
    log.append(RUN_ID, msg(2, "third report — under the overlay"));

    panel.handleInput("\x1b"); // esc → close overlay, full rebuild

    assert.equal(panelish.fullMessageEvent, null, "overlay closed");
    assert.equal(panelish.messageBodyList, null, "overlay body list dropped");
    assert.ok(panelish.timelineList, "timeline restored");
    // The rebuild must reflect the appended event: timeline has 3 rows now.
    const rendered = panel.render(120).join("\n");
    assert.match(rendered, /third report/, "post-close render includes the under-overlay event");
  } finally {
    cleanup();
  }
});
