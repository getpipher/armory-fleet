// memory-hydrate-adapter.test.mts — ArmoryMemoryAdapter three-scope composition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";

function seed(root: string, cwd: string, files: Record<string, string>): void {
  const dir = join(root, cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

test("renderScopes concatenates non-empty scopes in project → local → user order", () => {
  const root = `/tmp/armory-mem-test-${Date.now()}`;
  process.env.ARMORY_MEMORY_ROOT = root;
  seed(root, "/proj", { "p.md": "# Project\nproj body" });
  seed(root, "/parent", { "l.md": "# Local\nlocal body" });
  seed(root, "/__armory-fleet-user__", { "u.md": "# User\nuser body" });
  try {
    const adapter = new ArmoryMemoryAdapter();
    const block = adapter.renderScopes({ project: "/proj", local: "/parent", user: "/__armory-fleet-user__" });
    const pIdx = block.indexOf("Project");
    const lIdx = block.indexOf("Local");
    const uIdx = block.indexOf("User");
    assert.ok(pIdx >= 0 && lIdx > pIdx && uIdx > lIdx, `project before local before user; got:\n${block}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderScopes returns empty string when all scopes empty", () => {
  const root = `/tmp/armory-mem-empty-${Date.now()}`;
  process.env.ARMORY_MEMORY_ROOT = root;
  try {
    const adapter = new ArmoryMemoryAdapter();
    assert.equal(adapter.renderScopes({ project: "/none", local: "/none2", user: "/none3" }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderScopes omits empty scopes but keeps populated ones", () => {
  const root = `/tmp/armory-mem-partial-${Date.now()}`;
  process.env.ARMORY_MEMORY_ROOT = root;
  seed(root, "/proj", { "p.md": "# Project\nonly project" });
  try {
    const adapter = new ArmoryMemoryAdapter();
    const block = adapter.renderScopes({ project: "/proj", local: "/no-local", user: "/no-user" });
    assert.ok(block.includes("Project"));
    assert.ok(!block.includes("none —"), "no empty-scope placeholder leaks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});