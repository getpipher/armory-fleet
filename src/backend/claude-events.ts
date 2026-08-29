// src/backend/claude-events.ts — map one CC stream-json NDJSON line → ChildSessionEvent(s) (SPEC-3 §4.2).
// Returns null for: filtered echoes (our own user writes), unknown types, malformed lines.
// The caller logs null-but-parseable lines at debug (forward-compat: CC may add types we don't need).
import type { ChildSessionEvent } from "../engine/spawnSubagent.ts";

interface CCContentBlock { type: string; text?: string; id?: string; name?: string; }
interface CCMessage { role?: string; content?: CCContentBlock[]; usage?: Record<string, unknown>; }
interface CCEvent { type: string; subtype?: string; session_id?: string; message?: CCMessage; error?: { message?: string }; }

/** Map one line to ALL the ChildSessionEvents it implies. An assistant message carrying tool_use
 *  blocks yields the message_end PLUS one tool_execution_end per block (#61: the engine's
 *  zero-tool-call premature-return signal must count claude children too — without this, every
 *  completed claude run counted 0 tools and was falsely flagged). The per-block end event fires
 *  at message time, not per-tool completion (CC stream-json gives no finer granularity) — right
 *  enough for "did the child act", which is what the count is for. */
export function mapClaudeEvents(line: string): ChildSessionEvent[] {
  let ev: CCEvent;
  try {
    ev = JSON.parse(line) as CCEvent;
  } catch {
    return []; // malformed line — resilient
  }
  switch (ev.type) {
    case "system": {
      if (ev.subtype === "init" && typeof ev.session_id === "string") {
        return [{ type: "session_init", backendSessionId: ev.session_id }];
      }
      return [];
    }
    case "assistant": {
      const msg = ev.message;
      if (!msg) return [];
      const content = (msg.content ?? []).map((c) => ({ type: c.type, text: c.text }));
      const usage = msg.usage as { cost?: { total?: number } } | undefined;
      const events: ChildSessionEvent[] = [{ type: "message_end", message: { role: msg.role ?? "assistant", content, usage } }];
      for (const block of msg.content ?? []) {
        if (block.type === "tool_use") {
          events.push({ type: "tool_execution_end", toolCallId: block.id ?? "", toolName: block.name ?? "unknown", result: "", isError: false });
        }
      }
      return events;
    }
    case "result":
      // turn boundary (success or error_max_turns) → turn_end drives the budget
      return [{ type: "turn_end" }];
    case "error":
      return [{ type: "error", message: { role: "error", content: [{ type: "text", text: ev.error?.message ?? "claude error" }] } }];
    case "user":
      return []; // echo of our own stdin write — filtered
    default:
      return []; // unknown — forward-compat, caller logs at debug
  }
}

/** Single-event compat wrapper (claude-detector + existing consumers read one event per line). */
export function mapClaudeEvent(line: string): ChildSessionEvent | null {
  return mapClaudeEvents(line)[0] ?? null;
}