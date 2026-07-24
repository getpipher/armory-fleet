import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { discoverAgents } from "../src/registry/discovery.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(here, "..", "agents");

test("general-purpose-cc builtin loads with backend: claude", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  const cc = r.agents.get("general-purpose-cc");
  ok(cc, "general-purpose-cc present");
  strictEqual(cc!.backend, "claude");
  strictEqual(cc!.sessionKey, "general-purpose-cc");
  ok(cc!.rolePrompt.includes("Do not call the `todo` tool"));
});

test("general-purpose builtin still defaults to backend: pi", () => {
  const r = discoverAgents({ projectDir: null, globalDir: null, builtinDir });
  strictEqual(r.agents.get("general-purpose")!.backend, "pi");
});

test("discovery warns on an invalid backend value and skips the profile", () => {
  const tmp = join(here, "fixtures", "bad-backend");
  const r = discoverAgents({ projectDir: tmp, globalDir: null, builtinDir: null });
  ok(r.warnings.some((w) => /invalid backend/i.test(w)));
  ok(!r.agents.has("bad"));
});