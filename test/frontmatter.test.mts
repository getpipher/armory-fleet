// test/frontmatter.test.mts
import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { parseAgentFile } from "../src/registry/frontmatter.ts";

const BASE = `---
name: scout
description: Recon agent
model: anthropic/claude-sonnet-4
thinkingLevel: medium
tools: [read, bash]
skills: [recon]
todoSync: true
---
You are a scout. Be thorough.
`;

test("parses v0.1 frontmatter + role prompt body", () => {
  const a = parseAgentFile(BASE, "/x/.pi/agents/scout.md", "project");
  strictEqual(a.name, "scout");
  strictEqual(a.description, "Recon agent");
  strictEqual(a.model, "anthropic/claude-sonnet-4");
  strictEqual(a.thinkingLevel, "medium");
  deepStrictEqual(a.tools, ["read", "bash"]);
  deepStrictEqual(a.skills, ["recon"]);
  strictEqual(a.todoSync, true);
  strictEqual(a.rolePrompt, "You are a scout. Be thorough.\n");
  strictEqual(a.source, "project");
});

test("name defaults to filename when omitted", () => {
  const noName = `---
description: anon
---
body
`;
  strictEqual(parseAgentFile(noName, "/x/.pi/agents/anon.md", "global").name, "anon");
});

test("todoSync defaults to true when omitted", () => {
  const noSync = `---
name: g
description: g
---
body
`;
  strictEqual(parseAgentFile(noSync, "/x/g.md", "builtin").todoSync, true);
});

test("malformed frontmatter throws FrontmatterError", () => {
  const bad = `---
name: g
this is not: : valid yaml: [
---
body
`;
  throws(() => parseAgentFile(bad, "/x/g.md", "project"), { name: "FrontmatterError" });
});

test("empty description is rejected", () => {
  const noDesc = `---
name: g
---
body
`;
  throws(() => parseAgentFile(noDesc, "/x/g.md", "project"), { name: "FrontmatterError" });
});