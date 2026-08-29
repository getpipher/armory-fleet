// child-loader.test.mts — composeChildPrompt ordering + USER_PSEUDO_CWD sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeChildPrompt, USER_PSEUDO_CWD, memoryScopesFor, resolveChildSkills, resolveAdditionalSkillPaths } from "../src/engine/child-loader.ts";
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

test("memoryScopesFor: project=cwd, local=parent dir, user omitted by default", () => {
  const s = memoryScopesFor("/Users/x/local-dev/getpipher/armory-fleet");
  assert.equal(s.project, "/Users/x/local-dev/getpipher/armory-fleet");
  assert.equal(s.local, "/Users/x/local-dev/getpipher");
  assert.equal(s.user, undefined, "user omitted by default (SPEC-6-5)");
});

test("memoryScopesFor: includes user when includeUser: true", () => {
  const s = memoryScopesFor("/Users/x/local-dev/getpipher/armory-fleet", { includeUser: true });
  assert.equal(s.user, USER_PSEUDO_CWD, "user sentinel present when includeUser");
});

test("memoryScopesFor: omits user when includeUser: false", () => {
  const s = memoryScopesFor("/Users/x/local-dev/getpipher/armory-fleet", { includeUser: false });
  assert.equal(s.user, undefined, "user omitted when includeUser: false");
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

test("#40 resolveAdditionalSkillPaths: includes the shared user `~/.agents/skills` dir when it exists", () => {
  // The parent's pi package-manager scans `~/.agents/skills` + `<cwd>/.agents/skills` and feeds
  // them to the loader via extendResources — that's how firecrawl skills (which live in
  // `~/.agents/skills`, NOT `~/.pi/agent/skills`) reach the parent. The child's bare
  // DefaultResourceLoader skips that, so a `skills: ["firecrawl-scrape"]` opt-in can't resolve.
  // resolveAdditionalSkillPaths returns those dirs (existing only) for buildChildLoader to pass
  // as additionalSkillPaths, restoring the parent's skill surface for children.
  const exists = (p: string): boolean => p === "/Users/x/.agents/skills";
  const out = resolveAdditionalSkillPaths({ homedir: "/Users/x", cwd: "/Users/x/local-dev/repo", existsSync: exists });
  assert.deepEqual(out, ["/Users/x/.agents/skills"], `user .agents/skills included when present: ${JSON.stringify(out)}`);
});

test("#40 resolveAdditionalSkillPaths: includes the project `<cwd>/.agents/skills` dir too (matches the parent surface)", () => {
  const exists = (p: string): boolean => p === "/Users/x/local-dev/repo/.agents/skills";
  const out = resolveAdditionalSkillPaths({ homedir: "/Users/x", cwd: "/Users/x/local-dev/repo", existsSync: exists });
  assert.deepEqual(out, ["/Users/x/local-dev/repo/.agents/skills"], `project .agents/skills included: ${JSON.stringify(out)}`);
});

test("#40 resolveAdditionalSkillPaths: returns both user + project dirs when both exist (deduped, user first)", () => {
  const exists = (p: string): boolean => p === "/Users/x/.agents/skills" || p === "/Users/x/local-dev/repo/.agents/skills";
  const out = resolveAdditionalSkillPaths({ homedir: "/Users/x", cwd: "/Users/x/local-dev/repo", existsSync: exists });
  assert.deepEqual(out, ["/Users/x/.agents/skills", "/Users/x/local-dev/repo/.agents/skills"], `both dirs, user first: ${JSON.stringify(out)}`);
});

test("#40 resolveAdditionalSkillPaths: returns [] when neither dir exists (no env assumption)", () => {
  const out = resolveAdditionalSkillPaths({ homedir: "/Users/x", cwd: "/Users/x/repo", existsSync: () => false });
  assert.deepEqual(out, [], "no dirs when neither exists — no hard dependency on `~/.agents` layout");
});

test("#40 resolveAdditionalSkillPaths: dedupes when cwd IS home (project == user dir)", () => {
  // If the child cwd is the home dir itself, user + project paths collapse to one — don't list it twice.
  const exists = (p: string): boolean => p === "/Users/x/.agents/skills";
  const out = resolveAdditionalSkillPaths({ homedir: "/Users/x", cwd: "/Users/x", existsSync: exists });
  assert.deepEqual(out, ["/Users/x/.agents/skills"], `deduped when home == cwd: ${JSON.stringify(out)}`);
});
