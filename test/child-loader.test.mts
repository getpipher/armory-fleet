// child-loader.test.mts — composeChildPrompt ordering + USER_PSEUDO_CWD sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeChildPrompt, USER_PSEUDO_CWD, memoryScopesFor, resolveChildSkills } from "../src/engine/child-loader.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

test("composeChildPrompt orders rolePrompt → memoryBlock → base", () => {
  const out = composeChildPrompt({ rolePrompt: "PERSONA", memoryBlock: "## Memory\nstuff", base: "## Tools\n..." });
  assert.equal(out, "PERSONA\n\n## Memory\nstuff\n\n## Tools\n...");
});

test("composeChildPrompt omits the memory block when empty", () => {
  const out = composeChildPrompt({ rolePrompt: "PERSONA", memoryBlock: "", base: "## Tools\n..." });
  assert.equal(out, "PERSONA\n\n## Tools\n...");
});

test("USER_PSEUDO_CWD is a stable sentinel", () => {
  assert.equal(USER_PSEUDO_CWD, "/__armory-fleet-user__");
});

test("memoryScopesFor: project=cwd, local=parent dir, user=sentinel", () => {
  const s = memoryScopesFor("/Users/x/local-dev/getpipher/armory-fleet");
  assert.equal(s.project, "/Users/x/local-dev/getpipher/armory-fleet");
  assert.equal(s.local, "/Users/x/local-dev/getpipher");
  assert.equal(s.user, USER_PSEUDO_CWD);
});

test("#32 resolveChildSkills: agent with NO skills loads NO skills (not all installed)", () => {
  // The #32 fix: previously an agent with no `skills` field loaded ALL installed skills
  // (~42 → ~570K substrate). Now it loads [] — callers opt in via the subagent tool's `skills` param.
  const agentNoSkills = { skills: undefined } as Pick<AgentDef, "skills">;
  const cur = { skills: [{ name: "brainstorming" }, { name: "tdd" }, { name: "verify" }], diagnostics: [] as unknown[] };
  const out = resolveChildSkills(agentNoSkills, cur);
  assert.equal(out.skills.length, 0, "no skills loaded when agent declares none");
  assert.deepEqual(out.skills, []);
  assert.equal(out.diagnostics, cur.diagnostics, "diagnostics pass through");
});

test("#32 resolveChildSkills: agent with specific skills loads only those", () => {
  const agent = { skills: ["tdd", "verify"] } as Pick<AgentDef, "skills">;
  const cur = { skills: [{ name: "brainstorming" }, { name: "tdd" }, { name: "verify" }], diagnostics: [] as unknown[] };
  const out = resolveChildSkills(agent, cur);
  assert.equal(out.skills.length, 2);
  assert.deepEqual(out.skills.map((s) => s.name), ["tdd", "verify"]);
});

test("#32 resolveChildSkills: agent with empty skills array loads NO skills", () => {
  // An explicit `skills: []` is treated like no skills (lean substrate), not "load all".
  const agent = { skills: [] } as Pick<AgentDef, "skills">;
  const cur = { skills: [{ name: "brainstorming" }, { name: "tdd" }], diagnostics: [] as unknown[] };
  const out = resolveChildSkills(agent, cur);
  assert.equal(out.skills.length, 0, "explicit empty skills → no skills loaded");
});

test("#32 resolveChildSkills: filters by name, ignoring unknown skill names gracefully", () => {
  const agent = { skills: ["tdd", "does-not-exist"] } as Pick<AgentDef, "skills">;
  const cur = { skills: [{ name: "tdd" }, { name: "verify" }], diagnostics: [] as unknown[] };
  const out = resolveChildSkills(agent, cur);
  assert.deepEqual(out.skills.map((s) => s.name), ["tdd"], "unknown names silently dropped (not in arsenal)");
});
