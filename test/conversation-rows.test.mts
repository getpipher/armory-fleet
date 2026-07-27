// test/conversation-rows.test.mts
import { test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import {
  wrapToLines, messageBody, toolBody, messageHeader, toolHeader,
} from "../src/panel/conversation-rows.ts";
import type { MessageEvent, ToolEvent } from "../src/runtime/run-log.ts";

const msg = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  type: "message", role: "assistant", text: "hello world", turnIndex: 2, ...over,
});
const tool = (over: Partial<ToolEvent> = {}): ToolEvent => ({
  type: "tool", toolName: "bash", args: "echo hi", result: "hi", isError: false, turnIndex: 1, ...over,
});

test("wrapToLines: plain wrap at width", () => {
  deepStrictEqual(wrapToLines("hello world foo bar", 11), ["hello world", "foo bar"]);
});

test("wrapToLines: long token hard-splits at width", () => {
  deepStrictEqual(wrapToLines("abcdefghijklmnopqrstuvwxyz", 10), ["abcdefghij", "klmnopqrst", "uvwxyz"]);
});

test("wrapToLines: preserves explicit \\n as row breaks", () => {
  deepStrictEqual(wrapToLines("line1\nline2\nline3", 80), ["line1", "line2", "line3"]);
});

test("wrapToLines: empty input → ['']", () => {
  deepStrictEqual(wrapToLines("", 80), [""]);
});

test("wrapToLines: width <= 0 → [''] (defensive)", () => {
  deepStrictEqual(wrapToLines("anything", 0), [""]);
  deepStrictEqual(wrapToLines("anything", -1), [""]);
});

test("wrapToLines: CJK / no-break long line overflows by hard-split", () => {
  // 10 CJK chars (1 col each in terminal); width=4 → 4 per line
  deepStrictEqual(wrapToLines("中文测试一二三四五六", 4), ["中文测试", "一二三四", "五六"]);
});

test("messageBody: wraps full assistant text", () => {
  const lines = messageBody(msg({ text: "aaaa bbbb cccc" }), 9);
  deepStrictEqual(lines, ["aaaa bbbb", "cccc"]);
});

test("toolBody: args:/result: labels + 2sp indent + wrap", () => {
  const lines = toolBody(tool({ args: "echo hi", result: "hi there" }), 12);
  deepStrictEqual(lines, ["args:", "  echo hi", "result:", "  hi there"]);
});

test("toolBody: preserves multi-line result (\\n) as row breaks", () => {
  const lines = toolBody(tool({ result: "line1\nline2" }), 80);
  deepStrictEqual(lines, ["args:", "  echo hi", "result:", "  line1", "  line2"]);
});

test("toolBody: empty result still shows the label + blank indented line", () => {
  const lines = toolBody(tool({ result: "" }), 80);
  deepStrictEqual(lines, ["args:", "  echo hi", "result:", "  "]);
});

test("messageHeader: with usage → '── assistant · turn N · M tok ──'", () => {
  strictEqual(messageHeader(msg({ usage: { total: 142 }, turnIndex: 2 })), "── assistant · turn 2 · 142 tok ──");
});

test("messageHeader: without usage → omits the token segment", () => {
  strictEqual(messageHeader(msg({ turnIndex: 0 })), "── assistant · turn 0 ──");
});

test("toolHeader: success → '── tool: <name> · turn N · ✓ · args/result excerpted ──'", () => {
  strictEqual(toolHeader(tool({ toolName: "bash", turnIndex: 1, isError: false })), "── tool: bash · turn 1 · ✓ · args/result excerpted ──");
});

test("toolHeader: error → ✗ glyph", () => {
  strictEqual(toolHeader(tool({ toolName: "read", turnIndex: 3, isError: true })), "── tool: read · turn 3 · ✗ · args/result excerpted ──");
});