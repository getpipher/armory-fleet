// test/discovery.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/registry/discovery.ts";

function agentFile(name: string, desc = "d"): string {
  return `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`;
}

test("project agent overrides global agent of same name", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  const glob = mkdtempSync(join(tmpdir(), "glob-"));
  writeFileSync(join(proj, "a.md"), agentFile("a", "project-version"));
  writeFileSync(join(glob, "a.md"), agentFile("a", "global-version"));
  const r = discoverAgents({ projectDir: proj, globalDir: glob, builtinDir: null });
  strictEqual(r.agents.get("a")!.description, "project-version");
  strictEqual(r.warnings.length, 0);
  rmSync(proj, { recursive: true, force: true });
  rmSync(glob, { recursive: true, force: true });
});

test("same-scope collision is a load error (loud), duplicate ignored", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj2-"));
  writeFileSync(join(proj, "a.md"), agentFile("a", "one"));
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(join(proj, "sub", "a.md"), agentFile("a", "two"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: null });
  ok(r.errors.some((e) => e.includes("duplicate agent") && e.includes("'a'")), "collision error surfaced");
  ok(r.agents.has("a"), "first one kept");
  rmSync(proj, { recursive: true, force: true });
});

test("malformed file is skipped + warned, registry still loads siblings", () => {
  const proj = mkdtempSync(join(tmpdir(), "proj3-"));
  writeFileSync(join(proj, "bad.md"), "---\nname: g\nthis is: : bad\n---\nbody\n");
  writeFileSync(join(proj, "good.md"), agentFile("good"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: null });
  ok(r.warnings.some((w) => w.includes("bad.md")), "malformed warned");
  ok(r.agents.has("good"), "sibling loaded");
  rmSync(proj, { recursive: true, force: true });
});

test("builtin agents are included and overridable by project", () => {
  const builtin = mkdtempSync(join(tmpdir(), "builtin-"));
  const proj = mkdtempSync(join(tmpdir(), "proj4-"));
  writeFileSync(join(builtin, "general-purpose.md"), agentFile("general-purpose", "builtin"));
  writeFileSync(join(proj, "general-purpose.md"), agentFile("general-purpose", "project"));
  const r = discoverAgents({ projectDir: proj, globalDir: null, builtinDir: builtin });
  strictEqual(r.agents.get("general-purpose")!.description, "project");
  rmSync(builtin, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

test("missing dirs are tolerated (no throw)", () => {
  const r = discoverAgents({ projectDir: "/nonexistent", globalDir: "/nonexistent", builtinDir: null });
  strictEqual(r.agents.size, 0);
  strictEqual(r.errors.length, 0);
});