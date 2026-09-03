import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMcpPolicy } from "../src/governance/mcp-policy.ts";

test("matcher: exact tool deny wins with the matched entry in the reason", () => {
  const d = evaluateMcpPolicy(["github", "github__delete_repo"], { server: "github", tool: "delete_repo" });
  assert.deepEqual(d, { decision: "deny", reason: 'denied by armory-fleet mcpDeny policy: matched "github__delete_repo"' });
});

test("matcher: bare server entry denies every tool on that server", () => {
  for (const tool of ["delete_repo", "create_issue", "anything"]) {
    const d = evaluateMcpPolicy(["github"], { server: "github", tool });
    assert.equal(d.decision, "deny");
  }
});

test("matcher: non-listed server+tool allows", () => {
  const d = evaluateMcpPolicy(["github", "github__delete_repo"], { server: "slack", tool: "post_message" });
  assert.deepEqual(d, { decision: "allow" });
});

test("matcher: absent / undefined / empty deny list allows", () => {
  assert.deepEqual(evaluateMcpPolicy(undefined, { server: "github", tool: "delete_repo" }), { decision: "allow" });
  assert.deepEqual(evaluateMcpPolicy([], { server: "github", tool: "delete_repo" }), { decision: "allow" });
});

test("matcher: malformed entries cannot match (exact lookups only, no entry parsing)", () => {
  const d = evaluateMcpPolicy(["", "a__", "__b", "server__*"], { server: "a", tool: "b" });
  assert.deepEqual(d, { decision: "allow" });
});

test("matcher: does not mutate or read beyond server/tool (args ignored by contract)", () => {
  const target = { server: "github", tool: "delete_repo" };
  const d = evaluateMcpPolicy(["github__delete_repo"], target);
  assert.equal(d.decision, "deny");
});
