import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { DEFAULT_LIFECYCLE, DEFAULT_LIFECYCLE_SOURCE } from "../src/lifecycle/default.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("default lifecycle has 5 phases with the locked skill bundles", () => {
  strictEqual(DEFAULT_LIFECYCLE.name, "default");
  strictEqual(DEFAULT_LIFECYCLE.backend, "pi");
  strictEqual(DEFAULT_LIFECYCLE.phases.length, 5);
  const names = DEFAULT_LIFECYCLE.phases.map((p) => p.name);
  ok(names.includes("brainstorm") && names.includes("plan") && names.includes("implement") && names.includes("review") && names.includes("finish"));
});

test("brainstorm = brainstorming, checkpoint true", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "brainstorm")!;
  strictEqual(p.skills.join(","), "brainstorming");
  strictEqual(p.checkpoint, true);
});

test("implement = executing-plans+TDD+verification, checkpoint false", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "implement")!;
  ok(p.skills.includes("executing-plans"));
  ok(p.skills.includes("test-driven-development"));
  ok(p.skills.includes("verification-before-completion"));
  strictEqual(p.checkpoint, false, "review runs next; the review IS the gate");
});

test("review = requesting+receiving-code-review, checkpoint true", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "review")!;
  ok(p.skills.includes("requesting-code-review"));
  ok(p.skills.includes("receiving-code-review"));
  strictEqual(p.checkpoint, true);
});

test("finish = finishing-a-development-branch, no checkpoint (terminal)", () => {
  const p = DEFAULT_LIFECYCLE.phases.find((x) => x.name === "finish")!;
  strictEqual(p.skills.join(","), "finishing-a-development-branch");
  strictEqual(p.checkpoint, false, "terminal — no checkpoint after finish");
});

test("default lifecycle does NOT include systematic-debugging or using-git-worktrees", () => {
  const all = DEFAULT_LIFECYCLE.phases.flatMap((p) => p.skills);
  ok(!all.includes("systematic-debugging"), "fallback skill, not default");
  ok(!all.includes("using-git-worktrees"), "worktree isolation is SPEC-5a");
});

test("default lifecycle source parses back into the same def", async () => {
  const { parseLifecycleFile } = await import("../src/lifecycle/registry.ts");
  const reparsed = parseLifecycleFile(DEFAULT_LIFECYCLE_SOURCE, "<builtin>", "builtin");
  strictEqual(reparsed.phases.length, 5);
  strictEqual(reparsed.phases[0]?.name, "brainstorm");
});

test("lifecycles/default.md is in sync with DEFAULT_LIFECYCLE_SOURCE", () => {
  const file = readFileSync(join(process.cwd(), "lifecycles", "default.md"), "utf8");
  strictEqual(file, DEFAULT_LIFECYCLE_SOURCE);
});