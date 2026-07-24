// src/lifecycle/default.ts
import { join } from "node:path";
import { parseLifecycleFile } from "./registry.ts";
import type { LifecycleDef } from "./lifecycle-types.ts";

/** The package builtin lifecycles/ dir, resolved relative to this module. */
export function builtinLifecyclesDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "..", "lifecycles");
}

/** The shipped `default` lifecycle as a markdown string (frontmatter + ## phase templates).
 *  This is the single source of truth — it is both written to lifecycles/default.md
 *  (for human reading) AND parsed here at runtime so the builtin is always in sync. */
export const DEFAULT_LIFECYCLE_SOURCE = `---
name: default
description: The superpowers-native 5-phase lifecycle (brainstorm→plan→implement→review→finish).
backend: pi
phases:
  - name: brainstorm
    skills: [brainstorming]
    agent: general-purpose
    checkpoint: true
  - name: plan
    skills: [writing-plans]
    agent: general-purpose
    checkpoint: true
  - name: implement
    skills: [executing-plans, test-driven-development, verification-before-completion]
    agent: general-purpose
    checkpoint: false
  - name: review
    skills: [requesting-code-review, receiving-code-review]
    agent: general-purpose
    checkpoint: true
  - name: finish
    skills: [finishing-a-development-branch]
    agent: general-purpose
---

## brainstorm
You are the **brainstorm** phase of a superpowers lifecycle. Use the brainstorming skill.
Task: {{task}}
{% if prev %}Previous phase ({{prev.name}}) produced: {{prev.summary}}
Artifacts to read: {{prev.paths}}{% endif %}
Explore the task, produce a design doc per the brainstorming skill. End your response with an
\`Artifacts:\` block (YAML) listing the produced file paths + a kind.

## plan
You are the **plan** phase. Use writing-plans. Read the brainstorm phase's design artifact.
{% if prev %}Previous phase: {{prev.summary}} | Artifacts: {{prev.paths}}{% endif %}
{% if feedback %}Human feedback on a prior attempt: {{feedback}}{% endif %}
Write the implementation plan per writing-plans. End with an \`Artifacts:\` block.

## implement
You are the **implement** phase. Use executing-plans + test-driven-development + verification-before-completion.
Read the plan artifact. Implement it, run tests, verify before claiming done.
End with an \`Artifacts:\` block (files changed).

## review
You are the **review** phase. Use requesting-code-review + receiving-code-review.
Review the implementation against the plan + design. Produce review findings.
End with an \`Artifacts:\` block (review notes path).

## finish
You are the **finish** phase. Use finishing-a-development-branch.
Decide merge/PR/cleanup per the skill and execute it. End with an \`Artifacts:\` block
(or omit on a merge/PR with no further file artifact — terminal-phase exemption).
`;

export const DEFAULT_LIFECYCLE: LifecycleDef = parseLifecycleFile(
  DEFAULT_LIFECYCLE_SOURCE,
  "<builtin:default>",
  "builtin",
);