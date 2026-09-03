import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleWidth, truncateToWidth, excerpt } from "../src/present/width.ts";

test("stripAnsi removes SGR sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
});

test("visibleWidth ignores ANSI codes", () => {
  assert.equal(visibleWidth("\x1b[1m▶\x1b[0m ab"), 4);
});

test("truncateToWidth respects visible width and keeps ANSI", () => {
  const s = "\x1b[31mabcdefgh\x1b[0m";
  const out = truncateToWidth(s, 5);
  assert.equal(visibleWidth(out), 5);
  assert.ok(out.includes("\x1b[31m"));
});

test("truncateToWidth no-op when it fits", () => {
  assert.equal(truncateToWidth("abc", 5), "abc");
});

test("excerpt prefers a break at ':' or space", () => {
  assert.equal(excerpt("Review PR #12: fix the thing and then more text here", 20).endsWith("…"), true);
  assert.ok(excerpt("Review PR #12: fix the thing and then more text here", 20).length <= 21);
});

test("excerpt long unbroken token hard-cuts", () => {
  assert.equal(excerpt("a".repeat(30), 10).length, 11);
});
