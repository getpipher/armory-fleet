// frontmatter-spec2.test.mts — memoryHydrate + vision fields (bool, default true).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile } from "../src/registry/frontmatter.ts";

const OPT_OUT = `---
name: reviewer
description: reviews code
memoryHydrate: false
vision: false
---
body`;
const DEFAULT = `---
name: x
description: y
---
body`;

test("memoryHydrate + vision parse as booleans when set", () => {
  const a = parseAgentFile(OPT_OUT, "reviewer.md", "project");
  assert.equal(a.memoryHydrate, false);
  assert.equal(a.vision, false);
});

test("memoryHydrate + vision default to true when omitted", () => {
  const a = parseAgentFile(DEFAULT, "x.md", "global");
  assert.equal(a.memoryHydrate, true);
  assert.equal(a.vision, true);
});