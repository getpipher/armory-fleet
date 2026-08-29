import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mapClaudeEvent, mapClaudeEvents } from "../src/backend/claude-events.ts";

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
test("#61: assistant message with tool_use blocks → message_end + one tool_execution_end per block", () => {
  // The claude backend never emitted tool events (tool_use was flattened into message content),
  // so the #61 zero-tool-call signal counted every claude run as 0 tools — a systematic false
  // "premature return" flag on genuine completions.
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Running the checks" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } },
      ],
    },
  });
  const events = mapClaudeEvents(line);
  strictEqual(events.length, 3, "message_end + 2 tool_execution_end");
  strictEqual(events[0]!.type, "message_end", "message_end first (finalText/usage handling unchanged)");
  strictEqual(events[1]!.type, "tool_execution_end");
  strictEqual((events[1] as any).toolName, "Bash");
  strictEqual((events[1] as any).toolCallId, "toolu_1");
  strictEqual(events[2]!.type, "tool_execution_end");
  strictEqual((events[2] as any).toolName, "Read");
});

test("#61: mapClaudeEvent stays first-event-only (detector + existing consumers unchanged)", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  });
  const e = mapClaudeEvent(line);
  ok(e);
  strictEqual(e!.type, "message_end", "wrapper returns the message_end");
});

test("#61: assistant text-only message → no tool events (single message_end)", () => {
  const events = mapClaudeEvents(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
  strictEqual(events.length, 1);
  strictEqual(events[0]!.type, "message_end");
});
