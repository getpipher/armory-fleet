// index-spec2.test.mts — smoke that the extension entry wires the armory adapters.
import { test } from "node:test";
import assert from "node:assert/strict";

test("extension entry exports a default function", async () => {
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.default, "function");
});
