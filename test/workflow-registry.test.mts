import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverWorkflows, WorkflowRegistry } from "../src/workflows/registry.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeWorkflow(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.js`);
  writeFileSync(p, body, "utf8");
  return p;
}

const GOOD = `export const meta = { name: 'good', description: 'd', phases: [{ title: 'A' }] }
return 'good-result'`;

test("discover: project > global > builtin (later scope wins by name)", () => {
  const proj = mkdtempSync(join(tmpdir(), "wf-proj-"));
  const glob = mkdtempSync(join(tmpdir(), "wf-glob-"));
  const built = mkdtempSync(join(tmpdir(), "wf-built-"));
  try {
    writeWorkflow(built, "shared", `export const meta = { name: 'shared', description: 'builtin' }\nreturn 'builtin'`);
    writeWorkflow(glob, "shared", `export const meta = { name: 'shared', description: 'global' }\nreturn 'global'`);
    writeWorkflow(proj, "shared", `export const meta = { name: 'shared', description: 'project' }\nreturn 'project'`);
    const r = discoverWorkflows({ projectDir: proj, globalDir: glob, builtinDir: built });
    assert.equal(r.errors.length, 0);
    const def = r.workflows.get("shared");
    assert.ok(def);
    assert.equal(def!.source, "project"); // project shadows global + builtin
    assert.equal(def!.description, "project");
  } finally { [proj, glob, built].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test("discover: missing dirs → empty (no errors)", () => {
  const r = discoverWorkflows({ projectDir: join(tmpdir(), "no-pe"), globalDir: join(tmpdir(), "no-ge"), builtinDir: join(tmpdir(), "no-be") });
  assert.equal(r.workflows.size, 0);
  assert.equal(r.errors.length, 0);
});

test("discover: malformed .js (no meta export) → error surfaced, others still load", () => {
  const proj = mkdtempSync(join(tmpdir(), "wf-mal-"));
  try {
    writeWorkflow(proj, "bad", "module.exports = 123"); // no meta
    writeWorkflow(proj, "good", GOOD);
    const r = discoverWorkflows({ projectDir: proj, globalDir: join(tmpdir(), "x"), builtinDir: join(tmpdir(), "y") });
    assert.ok(r.errors.length >= 1);
    assert.ok(r.workflows.has("good"));
    assert.ok(!r.workflows.has("bad"));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("WorkflowRegistry: get + list", () => {
  const reg = new WorkflowRegistry(new Map<string, { name: string; description: string; phases: { title: string }[]; sourceText: string; body: string; executable: string; source: "builtin" | "global" | "project"; filePath: string }>([["a", { name: "a", description: "d", phases: [], sourceText: "", body: "", executable: "", source: "builtin", filePath: "/x" }]]));
  assert.ok(reg.get("a"));
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get("missing"), undefined);
});
