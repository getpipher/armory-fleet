import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRealm, compileWorkflowScript } from "../src/workflows/vm-realm.ts";
import { parseWorkflowSource, validateWorkflowName } from "../src/workflows/source.ts";

const SOURCE = `export const meta = {
  name: 'review',
  description: 'review code',
  phases: [{ title: 'Scan' }],
}
phase('Scan')
const value = await agent('inspect')
return value
`;

test("parseWorkflowSource retains source and produces an executable async body", async () => {
  const parsed = parseWorkflowSource(SOURCE, { filePath: "/review.js", requireMeta: true });
  assert.equal(parsed.meta?.name, "review");
  assert.match(parsed.body, /await agent/);
  assert.doesNotMatch(parsed.body, /export const meta/);
  const realm = buildRealm({
    agent: async () => "ok", parallel: async () => [], pipeline: async (v) => v,
    phase: () => {}, workflow: async () => null, verify: async () => null,
    judgePanel: async () => null, loopUntilDry: async () => [], completenessCheck: async () => null,
    gate: async () => null, retry: async () => null, checkpoint: async () => true,
    log: () => {}, args: undefined, cwd: "/tmp",
    budget: { total: Infinity, spent: () => 0, remaining: () => Infinity },
  });
  assert.equal(await compileWorkflowScript(parsed.executable).runInContext(realm), "ok");
});

test("all shipped builtins parse and compile", () => {
  for (const name of ["code-review", "deep-research", "adversarial-review", "multi-perspective", "codebase-audit"]) {
    const filePath = join(process.cwd(), "src", "workflows", "builtin", `${name}.js`);
    const parsed = parseWorkflowSource(readFileSync(filePath, "utf8"), { filePath, requireMeta: true });
    assert.equal(parsed.meta?.name, name);
    assert.doesNotThrow(() => compileWorkflowScript(parsed.executable));
  }
});

test("legacy CommonJS is preserved and malformed metadata is actionable", () => {
  const legacy = "module.exports = (async () => 7)()";
  assert.equal(parseWorkflowSource(legacy, { filePath: "inline", requireMeta: false }).executable, legacy);
  assert.throws(
    () => parseWorkflowSource("export const meta = { name: 'x' }\nreturn 1", { filePath: "/x.js", requireMeta: true }),
    /\/x\.js: meta\.description missing/,
  );
});

test("workflow names reject traversal and accept kebab-case", () => {
  assert.doesNotThrow(() => validateWorkflowName("auth-audit"));
  for (const bad of ["", "../x", "A", "a_b", "con", "x/y"]) {
    assert.throws(() => validateWorkflowName(bad), /invalid workflow name/);
  }
});
