import { test, beforeEach, afterEach } from "node:test";
import { strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumeStore } from "../src/backend/resume-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-resume-"));
  process.env.FLEET_RESUME_ROOT = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FLEET_RESUME_ROOT;
});

test("set/get per backend + sessionKey", () => {
  const s = new ResumeStore();
  strictEqual(s.get("claude", "foo"), null);
  s.set("claude", "foo", "sess-1");
  strictEqual(s.get("claude", "foo"), "sess-1");
  strictEqual(s.get("pi", "foo"), null);
  s.set("pi", "foo", "/path/to/pi.jsonl");
  strictEqual(s.get("pi", "foo"), "/path/to/pi.jsonl");
});

test("clear removes a single entry", () => {
  const s = new ResumeStore();
  s.set("claude", "foo", "sess-1");
  s.clear("claude", "foo");
  strictEqual(s.get("claude", "foo"), null);
});

test("persists across instances (file-backed)", () => {
  const s1 = new ResumeStore();
  s1.set("claude", "foo", "sess-1");
  const s2 = new ResumeStore();   // re-reads the file
  strictEqual(s2.get("claude", "foo"), "sess-1");
});