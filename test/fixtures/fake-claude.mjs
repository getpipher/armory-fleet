#!/usr/bin/env node
// test/fixtures/fake-claude.mjs — emulates claude for detector tests.
const args = process.argv.slice(2);
const schemaProbe = process.env.FLEET_FAKE_CLAUDE_PROBE ?? "init-ok";

if (args.includes("--version")) {
  process.stdout.write("1.0.17 (fake-claude)\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("Usage: claude [options]\n  --disallowed-tools <tools>\n  --allowed-tools <tools>\n  --max-turns <n>\n  --resume <id>\n  --append-system-prompt <text>\n  --output-format <fmt>\n");
  process.exit(0);
}
// Otherwise: a -p stream-json invocation. Emit one init line + a result.
if (schemaProbe === "init-ok") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sess", cwd: process.cwd(), version: "1.0.17" }) + "\n");
} else if (schemaProbe === "init-drift") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", cwd: process.cwd() }) + "\n");  // no session_id
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "pong" }) + "\n");
process.exit(0);