// test/builtin.test.mts
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { discoverAgents } from "../src/registry/discovery.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(here, "..", "agents");

test("general-purpose builtin loads from package agents/ dir", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  const g = r.agents.get("general-purpose");
  ok(g, "general-purpose present");
  strictEqual(g!.source, "builtin");
  strictEqual(g!.todoSync, true);
  ok(g!.rolePrompt.includes("Do not call the `todo` tool"));
});