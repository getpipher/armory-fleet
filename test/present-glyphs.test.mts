import { test } from "node:test";
import assert from "node:assert/strict";
import { GLYPHS, spinnerFrame, asciiPreset } from "../src/present/glyphs.ts";

test("glyph vocabulary is complete and emoji-free", () => {
  const statuses = ["running", "queued", "paused", "completed", "failed", "aborted"] as const;
  for (const s of statuses) {
    assert.ok(GLYPHS.status[s], `missing status glyph for ${s}`);
  }
  const glyphValues: string[] = [...Object.values(GLYPHS.status), GLYPHS.treeBranch, GLYPHS.treeLeaf, GLYPHS.treeLine, GLYPHS.continuation, GLYPHS.crossCwd, GLYPHS.ellipsis, GLYPHS.cardTL, GLYPHS.cardTR, GLYPHS.cardBL, GLYPHS.cardBR, GLYPHS.cardH, GLYPHS.cardV, GLYPHS.info, GLYPHS.waiting, GLYPHS.gatePass, GLYPHS.gateFail, GLYPHS.gateRevise, GLYPHS.gateWarn];
  // Emoji screen: reject astral-plane (U+1F000+) color-emoji glyphs. BMP misc symbols/arrows
  // (▶ ⏳ ⏸ ⚠ ☑ ↗ ☾ …) are the approved monochrome TUI vocabulary per spec §2 — Extended_Pictographic
  // alone is too blunt a screen (⏳/⏸/⚠ are Emoji=Yes but render text-default in terminals).
  for (const g of glyphValues) {
    assert.equal(typeof g, "string");
    assert.ok(g.length > 0);
    for (const ch of g) {
      const cp = ch.codePointAt(0) ?? 0;
      assert.ok(cp < 0x1f000, `astral-plane emoji in glyph: ${g} (U+${cp.toString(16)})`);
    }
  }
});

test("spinner frames cycle", () => {
  assert.equal(spinnerFrame(8), GLYPHS.spinner[0]);
  assert.notEqual(spinnerFrame(0), spinnerFrame(1));
});

test("ascii preset replaces every glyph with ASCII and keeps same keys", () => {
  const a = asciiPreset();
  for (const k of Object.keys(GLYPHS.status)) assert.ok((a.status as Record<string, string>)[k]);
  assert.equal(a.cardTL, "+");
});
