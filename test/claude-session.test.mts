import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ResumeStore } from "../src/backend/resume-store.ts";
import { ClaudeChildSession } from "../src/backend/claude-session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude-stream.mjs");

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-cc-sess-")); process.env.FLEET_RESUME_ROOT = root; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.FLEET_RESUME_ROOT; });

function spawnFake(): ClaudeChildSession {
  const proc = spawn(fakeBin, [], { stdio: ["pipe", "pipe", "pipe"] });
  return new ClaudeChildSession(proc, "foo", new ResumeStore());
}

test("subscribe receives session_init then turn_end; backendSessionId captured + persisted", async () => {
  const sess = spawnFake();
  const events: string[] = [];
  sess.subscribe((e) => { events.push(e.type); });
  await sess.prompt("hello");
  strictEqual(events[0], "session_init");
  ok(events.includes("turn_end"));
  strictEqual((new ResumeStore()).get("claude", "foo"), "fake-stream-sess");
  sess.dispose();
});

test("abort kills the process", async () => {
  const sess = spawnFake();
  await sess.abort();
  ok(sess.isDisposed());
  sess.dispose();
});

test("dispose is idempotent", () => {
  const sess = spawnFake();
  sess.dispose();
  sess.dispose(); // no throw
  ok(sess.isDisposed());
});