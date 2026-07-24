// child-loader.test.mts — composeChildPrompt ordering + USER_PSEUDO_CWD sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeChildPrompt, USER_PSEUDO_CWD, memoryScopesFor } from "../src/engine/child-loader.ts";

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