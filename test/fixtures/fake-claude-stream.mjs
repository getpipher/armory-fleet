#!/usr/bin/env node
// test/fixtures/fake-claude-stream.mjs — emulates a streaming `claude -p --output-format stream-json`.
// On each stdin line (a user NDJSON message), emit init (once) + assistant + result.
let wroteInit = false;
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    if (!wroteInit) {
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-stream-sess", cwd: process.cwd(), version: "1.0.17" }) + "\n");
      wroteInit = true;
    }
    process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));