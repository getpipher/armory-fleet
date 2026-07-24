// src/backend/claude-events.ts — map one CC stream-json NDJSON line → ChildSessionEvent (SPEC-3 §4.2).
// Returns null for: filtered echoes (our own user writes), unknown types, malformed lines.
// The caller logs null-but-parseable lines at debug (forward-compat: CC may add types we don't need).
import type { ChildSessionEvent } from "../engine/spawnSubagent.ts";

interface CCMessage { role?: string; content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown>; }
interface CCEvent { type: string; subtype?: string; session_id?: string; message?: CCMessage; error?: { message?: string }; }

export function mapClaudeEvent(line: string): ChildSessionEvent | null {
  let ev: CCEvent;
  try {
    ev = JSON.parse(line) as CCEvent;
  } catch {
    return null; // malformed line — resilient
  }
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init" && typeof ev.session_id === "string") {
        return { type: "session_init", backendSessionId: ev.session_id };
      }
      return null;
    case "assistant": {
      const msg = ev.message;
      if (!msg) return null;
      const content = (msg.content ?? []).map((c) => ({ type: c.type, text: c.text }));
      const usage = msg.usage as { cost?: { total?: number } } | undefined;
      return { type: "message_end", message: { role: msg.role ?? "assistant", content, usage } };
    }
    case "result":
      // turn boundary (success or error_max_turns) → turn_end drives the budget
      return { type: "turn_end" };
    case "error":
      return { type: "error", message: { role: "error", content: [{ type: "text", text: ev.error?.message ?? "claude error" }] } };
    case "user":
      return null; // echo of our own stdin write — filtered
    default:
      return null; // unknown — forward-compat, caller logs at debug
  }
}