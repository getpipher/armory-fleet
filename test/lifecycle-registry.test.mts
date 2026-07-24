import { test } from "node:test";
import { strictEqual, throws, ok } from "node:assert";
import { parseLifecycleFile, LifecycleParseError } from "../src/lifecycle/registry.ts";

const GOOD = `---
name: default
description: superpowers-5
backend: pi
phases:
  - name: brainstorm
    skills: [brainstorming]
    checkpoint: true
  - name: plan
    skills: [writing-plans]
  - name: finish
    skills: [finishing-a-development-branch]
---

## brainstorm
You are the brainstorm phase. Task: {{task}}

## plan
You are the plan phase. {% if prev %}prev: {{prev.summary}}{% endif %}

## finish
You are the finish phase.
`;

test("parses a well-formed lifecycle file", () => {
  const def = parseLifecycleFile(GOOD, "/x/default.md", "builtin");
  strictEqual(def.name, "default");
  strictEqual(def.backend, "pi");
  strictEqual(def.phases.length, 3);
  strictEqual(def.phases[0]?.name, "brainstorm");
  strictEqual(def.phases[0]?.skills[0], "brainstorming");
  strictEqual(def.phases[0]?.checkpoint, true);
  strictEqual(def.phases[1]?.checkpoint, true, "checkpoint defaults to true when omitted");
  strictEqual(def.phases[1]?.agent, undefined, "agent defaults to undefined → general-purpose at resolve time");
  ok(def.phases[0]?.promptTemplate.includes("{{task}}"));
  ok(def.phases[2]?.promptTemplate.includes("finish phase"));
});

test("backend defaults to pi when omitted", () => {
  const def = parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project");
  strictEqual(def.backend, "pi");
});

test("rejects invalid backend", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
backend: gemini
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /invalid backend/.test((e as Error).message),
  );
});

test("rejects empty phases", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: []
---
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /at least one phase|non-empty/.test((e as Error).message),
  );
});

test("rejects a phase declared in frontmatter but with no body section", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: brainstorm, skills: [] }, { name: plan, skills: [] }]
---
## brainstorm
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /missing.*template.*plan/.test((e as Error).message),
  );
});

test("rejects a phase with no body section at all (single phase, no body)", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }]
---
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /missing.*template.*\ba\b/.test((e as Error).message),
  );
});

test("rejects duplicate phase names", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
description: q
phases: [{ name: a, skills: [] }, { name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /duplicate phase.*a/.test((e as Error).message),
  );
});

test("rejects missing frontmatter delimiters", () => {
  throws(
    () => parseLifecycleFile("no frontmatter here", "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /frontmatter delimiters/.test((e as Error).message),
  );
});

test("rejects missing description", () => {
  throws(
    () => parseLifecycleFile(`---
name: q
phases: [{ name: a, skills: [] }]
---
## a
x
`, "/x/q.md", "project"),
    (e: unknown) => e instanceof LifecycleParseError && /description is required/.test((e as Error).message),
  );
});