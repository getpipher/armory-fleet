// test/transcript-run-card.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCardLines, finalLine, stateLine } from "../src/transcript/run-card.ts";
import { liveCardLines as lcl, CARD_WIDTH } from "../src/transcript/run-card.ts";
import { visibleWidth } from "../src/present/width.ts";

const base = {
  runId: "fl-x", agent: "reviewer", model: "glm", task: "Review PR #102",
  status: "running" as const, startedAt: 0, turnCount: 3,
  lastEventClass: "tool:read", contextTokens: 186_000, maxContext: 1_000_000,
};

test("live card frames with spinner, agent, clock, state line", () => {
  const lines = liveCardLines({ ...base } as never, 41_000, 0, 80);
  assert.equal(lines.length, 4);                       // top / task / state / bottom
  assert.ok(lines[0]!.includes("⣾"));
  assert.ok(lines[0]!.includes("reviewer"));
  assert.ok(lines[1]!.includes("Review PR #102"));
  assert.ok(lines[2]!.includes("turn 3"));
  assert.ok(lines[2]!.includes("41s"));
  assert.ok(lines[2]!.includes("19%"));                  // 186K/1M
});

test("final line completed shows money and files; failed shows — honesty", () => {
  const theme = { fg: (_t: string, s: string) => s, bold: (s: string) => s };
  const ok = finalLine({ ...base, status: "completed", costTotal: 0.3, filesTouched: 3, resultSummary: "Ship", endedAt: 252_000 } as never, theme as never);
  assert.ok(ok.includes("✓ reviewer"));
  assert.ok(ok.includes("$0.30"));
  assert.ok(ok.includes("✎3"));
  assert.ok(ok.includes("4m12s"));                      // endedAt - startedAt, replay-safe
  const bad = finalLine({ ...base, status: "failed", error: "boom" } as never, theme as never);
  assert.ok(bad.includes("✗ reviewer"));
  assert.ok(bad.includes("—"));
  assert.ok(bad.includes("boom"));
});

test("every card line shares one visible width (frame geometry, #108)", () => {
  for (const width of [CARD_WIDTH, 80, 120]) {
    const lines = lcl({ ...base } as never, 41_000, 0, width);
    const widths = lines.map((l) => visibleWidth(l));
    assert.equal(lines.length, 4);
    for (const w of widths) assert.equal(w, widths[0], `width param ${width}`);
  }
});

test("top and bottom bars meet the corners (╮/╯ present, bars ≥ 3)", () => {
  const lines = lcl({ ...base } as never, 41_000, 0, CARD_WIDTH);
  assert.match(lines[0]!, /^╭─ ⣾ fleet · reviewer · glm ─+╮$/);
  assert.match(lines[3]!, /^╰─+╯$/);
  assert.ok(lines[0]!.includes("───"));
});

test("empty model suppresses the head segment (no dangling ·)", () => {
  const lines = lcl({ ...base, model: "" } as never, 41_000, 0, CARD_WIDTH);
  assert.match(lines[0]!, /^╭─ ⣾ fleet · reviewer ─+╮$/);
});

test("empty lastEventClass leaves no dangling separator (regression, #108 item 3)", () => {
  const lines = lcl({ ...base, lastEventClass: "" } as never, 41_000, 0, CARD_WIDTH);
  assert.doesNotMatch(lines[2]!, /·\s*·/);       // no doubled separators
  assert.ok(!lines[2]!.trimEnd().endsWith("·")); // no trailing separator
});

test("finalLine survives a real Theme.fg contract — raw status would throw (#108 item 4)", () => {
  const TOKENS = new Set(["accent", "dim", "warning", "success", "error", "text", "muted"]);
  const realTheme = {
    fg: (t: string, s: string) => {
      if (!TOKENS.has(t)) throw new Error(`Unknown theme color: ${t}`);
      return s;
    },
    bold: (s: string) => s,
  };
  const done = finalLine({ ...base, status: "completed", endedAt: 252_000, resultSummary: "Ship" } as never, realTheme as never);
  assert.ok(done.includes("✓ reviewer"));
  const bad = finalLine({ ...base, status: "failed", error: "boom" } as never, realTheme as never);
  assert.ok(bad.includes("✗ reviewer"));
});

test("stateLine: full fields render the exact card state segment", () => {
  assert.equal(stateLine({ ...base } as never, 41_000, 0), "⣾ · ●tool:read · turn 3 · 41s · 186K tok · 19%");
});

test("stateLine: missing optionals drop cleanly (no dangling ·)", () => {
  assert.equal(stateLine({ ...base, lastEventClass: undefined, turnCount: undefined, contextTokens: undefined } as never, 41_000, 0), "⣾ · 41s");
});

test("stateLine: parity — liveCardLines state row contains stateLine output verbatim", () => {
  const lines = lcl({ ...base } as never, 41_000, 0, CARD_WIDTH);
  assert.ok(lines[2]!.includes(stateLine({ ...base } as never, 41_000, 0)));
});
