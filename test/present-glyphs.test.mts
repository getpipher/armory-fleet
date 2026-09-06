import { test } from "node:test";
import assert from "node:assert/strict";
import { GLYPHS, spinnerFrame, asciiPreset, unicodePreset, nerdPreset, resolvePresetName, pickPreset } from "../src/present/glyphs.ts";
import { visibleWidth } from "../src/present/width.ts";

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

test("every preset satisfies the GlyphMap key set (parity with unicode)", () => {
  const keysOf = (g: ReturnType<typeof unicodePreset>): string[] => Object.keys(g).sort();
  const want = keysOf(unicodePreset());
  for (const p of [asciiPreset(), nerdPreset()]) {
    assert.deepEqual(keysOf(p as never), want, "preset key parity");
    assert.deepEqual(Object.keys(p.status).sort(), Object.keys(unicodePreset().status).sort(), "status key parity");
  }
  for (const p of [unicodePreset(), asciiPreset(), nerdPreset()]) {
    assert.ok(p.footerSep.length > 0, "footerSep present");
    assert.ok(p.spinner.length >= 2, "spinner has frames");
  }
});

test("resolvePresetName: trim + lowercase; absent/empty/unknown → unicode", () => {
  assert.equal(resolvePresetName(undefined), "unicode");
  assert.equal(resolvePresetName(""), "unicode");
  assert.equal(resolvePresetName("unicode"), "unicode");
  assert.equal(resolvePresetName("ascii"), "ascii");
  assert.equal(resolvePresetName("nerd"), "nerd");
  assert.equal(resolvePresetName("  NERD  "), "nerd");
  assert.equal(resolvePresetName("bogus"), "unicode");
});

test("pickPreset: unknown non-empty env warns once on stderr and falls back to unicode", () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (s: string) => { errors.push(s); };
  try {
    const g = pickPreset("bogus");
    assert.equal(g.status.running, unicodePreset().status.running);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /ARMORY_FLEET_GLYPHS/);
    assert.equal(pickPreset("unicode").status.running, "▶"); // valid explicit value → still exactly one warning total
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
  }
  assert.equal(pickPreset("ascii").footerSep, "|");
});

test("nerd preset: PUA icons are single-width, BMP-only (pass the astral screen)", () => {
  const n = nerdPreset();
  const icons = [n.status.running, n.status.queued, n.status.paused, n.status.completed, n.status.failed, n.crossCwd, n.ellipsis, n.info, n.waiting, n.eventDot, n.filesTouched, n.gateRevise, n.gateWarn, n.todoDone, n.todoOpen];
  for (const g of icons) {
    assert.equal(visibleWidth(g), 1, `single width: U+${g.codePointAt(0)!.toString(16)}`);
    for (const ch of g) assert.ok(ch.codePointAt(0)! < 0x1f000, "no astral emoji");
  }
  assert.equal(n.footerSep, "│");
  // Connectors stay unicode per ratified design
  assert.equal(n.treeBranch, "├");
  assert.equal(n.cardTL, "╭");
});
