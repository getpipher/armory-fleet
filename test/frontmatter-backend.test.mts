import { test } from "node:test";
import { strictEqual, throws } from "node:assert";
import { parseAgentFile, FrontmatterError } from "../src/registry/frontmatter.ts";

const FM = (body: string) => `---\n${body}\n---\nrole body`;

test("backend defaults to pi", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d"), "/x.md", "builtin");
  strictEqual(a.backend, "pi");
});

test("backend: claude parses", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d\nbackend: claude"), "/x.md", "builtin");
  strictEqual(a.backend, "claude");
});

test("invalid backend is a FrontmatterError", () => {
  throws(
    () => parseAgentFile(FM("name: g\ndescription: d\nbackend: codex"), "/x.md", "builtin"),
    (e: Error) => e instanceof FrontmatterError && /backend/i.test(e.message) && /pi|claude/i.test(e.message),
  );
});

test("sessionKey defaults to name", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d"), "/x.md", "builtin");
  strictEqual(a.sessionKey, "g");
});

test("sessionKey explicit overrides name", () => {
  const a = parseAgentFile(FM("name: g\ndescription: d\nsessionKey: shared-refine"), "/x.md", "builtin");
  strictEqual(a.sessionKey, "shared-refine");
});