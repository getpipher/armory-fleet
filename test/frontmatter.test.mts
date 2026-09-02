// test/frontmatter.test.mts
import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws, ok } from "node:assert";
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

const WITH_TIER = `---
name: scout
description: Recon agent
tier: standard
---
You are a scout.
`;

test("parses optional tier field (SPEC-6-1)", () => {
  const a = parseAgentFile(WITH_TIER, "/x/.pi/agents/scout.md", "project");
  strictEqual(a.tier, "standard");
});

test("tier absent → undefined (back-compat)", () => {
  const a = parseAgentFile(BASE, "/x/.pi/agents/scout.md", "project");
  strictEqual(a.tier, undefined);
});

test("userMemory defaults to false when absent", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\n---\nrole", "/tmp/agent.md", "builtin");
  strictEqual(a.userMemory, false, "userMemory defaults false");
});

test("userMemory: true parses true", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\nuserMemory: true\n---\nrole", "/tmp/agent.md", "builtin");
  strictEqual(a.userMemory, true);
});

test("userMemory: false parses false", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\nuserMemory: false\n---\nrole", "/tmp/agent.md", "builtin");
  strictEqual(a.userMemory, false);
});
// --- #90: thinkingLevel is a closed enum — invalid values throw (like backend),
// never silently no-op. Same value class, same contract. ---

test("#90: invalid thinkingLevel string throws FrontmatterError with actionable message", () => {
  const bad = "---\nname: g\ndescription: d\nthinkingLevel: ultra\n---\nbody\n";
  throws(
    () => parseAgentFile(bad, "/x/g.md", "project"),
    (e: unknown) => {
      ok(e instanceof Error && e.name === "FrontmatterError", `FrontmatterError, got ${String(e)}`);
      ok(e instanceof Error && e.message.includes("invalid thinkingLevel"), `names the field: ${e.message}`);
      ok(e instanceof Error && e.message.includes("ultra"), `names the bad value: ${e.message}`);
      ok(e instanceof Error && e.message.includes("off|minimal|low|medium|high|xhigh|max"), `lists valid levels: ${e.message}`);
      return true;
    },
  );
});

test("#90: non-string thinkingLevel throws FrontmatterError", () => {
  const bad = "---\nname: g\ndescription: d\nthinkingLevel: 5\n---\nbody\n";
  throws(() => parseAgentFile(bad, "/x/g.md", "project"), { name: "FrontmatterError" });
});

test("#90: thinkingLevel absent → undefined (back-compat)", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\n---\nrole", "/tmp/agent.md", "builtin");
  strictEqual(a.thinkingLevel, undefined);
});

test("#90: thinkingLevel null (YAML empty value) → treated as absent", () => {
  const a = parseAgentFile("---\nname: a\ndescription: d\nthinkingLevel:\n---\nrole", "/tmp/agent.md", "builtin");
  strictEqual(a.thinkingLevel, undefined);
});

test("#90: all seven thinking levels parse", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const md = `---\nname: a\ndescription: d\nthinkingLevel: ${level}\n---\nrole\n`;
    strictEqual(parseAgentFile(md, "/tmp/agent.md", "builtin").thinkingLevel, level, `level ${level}`);
  }
});
