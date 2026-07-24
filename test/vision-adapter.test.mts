// vision-adapter.test.mts — ArmoryVisionAdapter capability-aware delegation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArmoryVisionAdapter } from "../src/vision/adapter.ts";

// Fake ModelRegistry slice (the { find, getApiKeyAndHeaders } delegateToVisionModel reads).
const fakeRegistry = {
  find: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
};

test("isMultimodal delegates to vision's isMultimodal", () => {
  const adapter = new ArmoryVisionAdapter({ modelRegistry: fakeRegistry as any, cwd: "/tmp", agentDir: "/tmp" });
  assert.equal(adapter.isMultimodal(undefined), false);
  assert.equal(adapter.isMultimodal({ input: ["text", "image"] } as any), true);
  assert.equal(adapter.isMultimodal({ input: ["text"] } as any), false);
});

test("isConfigured reflects the loaded config", () => {
  const adapter = new ArmoryVisionAdapter({ modelRegistry: fakeRegistry as any, cwd: "/tmp", agentDir: "/tmp" });
  assert.equal(typeof adapter.isConfigured(), "boolean");
});

test("delegate returns actionable error when no vision model is configured", async () => {
  const adapter = new ArmoryVisionAdapter({ modelRegistry: fakeRegistry as any, cwd: "/tmp", agentDir: "/tmp/no-vision-config" });
  const result = await adapter.delegate({ imagePath: "/nonexistent.png" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no vision model configured|not configured|not_configured|model/i);
});