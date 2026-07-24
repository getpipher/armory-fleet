import { test } from "node:test";
import { ok } from "node:assert";
import { subagentParams } from "../src/tools/subagent.ts";

test("subagent params include optional lifecycle + auto", () => {
  ok("lifecycle" in subagentParams.properties, "lifecycle param present");
  ok("auto" in subagentParams.properties, "auto param present");
  const required = (subagentParams as { required?: string[] }).required ?? [];
  ok(!required.includes("lifecycle"));
  ok(!required.includes("auto"));
});

test("lifecycle absent → single-run path is unchanged (signature regression)", () => {
  ok("agent" in subagentParams.properties);
  ok("task" in subagentParams.properties);
});