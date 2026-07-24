import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mapClaudeEvent } from "../src/backend/claude-events.ts";

test("init event → session_init with backendSessionId", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", cwd: "/x", version: "1.0.0" }));
  ok(e);
  strictEqual(e!.type, "session_init");
  strictEqual(e!.backendSessionId, "abc-123");
});

test("assistant text message → message_end with role + content", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }));
  ok(e);
  strictEqual(e!.type, "message_end");
  strictEqual(e!.message?.role, "assistant");
  strictEqual(e!.message?.content?.[0]?.text, "hi");
});

test("result success → turn_end", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "result", subtype: "success", result: "done" }));
  ok(e);
  strictEqual(e!.type, "turn_end");
});

test("result error_max_turns → turn_end (engine maps to failed)", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "result", subtype: "error_max_turns" }));
  ok(e);
  strictEqual(e!.type, "turn_end");
});

test("user echo (our stdin write) → filtered (null)", () => {
  strictEqual(mapClaudeEvent(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] } })), null);
});

test("unknown event type → null (caller logs at debug; not crashed on)", () => {
  strictEqual(mapClaudeEvent(JSON.stringify({ type: "something_new", data: 1 })), null);
});

test("malformed JSON line → null (resilient)", () => {
  strictEqual(mapClaudeEvent("not json"), null);
});

test("error event → error event forwarded", () => {
  const e = mapClaudeEvent(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
  ok(e);
  strictEqual(e!.type, "error");
});