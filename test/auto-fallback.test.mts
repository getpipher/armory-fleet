// test/auto-fallback.test.mts — #58: ARMORY_FLEET_MODEL_FALLBACK=auto sentinel resolution.
import { test } from "node:test";
import { strictEqual } from "node:assert";
import { resolveAutoFallback } from "../src/engine/auto-fallback.ts";

test("#58 auto: prefers the first available model from a DIFFERENT provider than the session model", () => {
  const pick = resolveAutoFallback(
    [
      { provider: "Ollama", id: "minimax-m3:cloud" },
      { provider: "openrouter", id: "z-ai/glm-5.2" },
      { provider: "openai", id: "gpt-5.2" },
    ],
    { provider: "Ollama", id: "glm-5.2:cloud" },
  );
  strictEqual(pick, "openrouter/z-ai/glm-5.2", "first different-provider model wins (family fallback)");
});

test("#58 auto: same-provider different-id when no other provider is available", () => {
  const pick = resolveAutoFallback(
    [
      { provider: "Ollama", id: "glm-5.2:cloud" },
      { provider: "Ollama", id: "minimax-m3:cloud" },
    ],
    { provider: "Ollama", id: "glm-5.2:cloud" },
  );
  strictEqual(pick, "Ollama/minimax-m3:cloud", "falls back to a different model on the same provider");
});

test("#58 auto: single-model setup → undefined (caller keeps auto-retry off + surfaces why)", () => {
  const pick = resolveAutoFallback([{ provider: "Ollama", id: "glm-5.2:cloud" }], { provider: "Ollama", id: "glm-5.2:cloud" });
  strictEqual(pick, undefined, "nothing differs from the primary → no auto fallback");
});

test("#58 auto: empty available snapshot → undefined", () => {
  strictEqual(resolveAutoFallback([], { provider: "Ollama", id: "glm-5.2:cloud" }), undefined);
});

test("#58 auto: never picks the session model itself even when other models exist", () => {
  const pick = resolveAutoFallback(
    [
      { provider: "Ollama", id: "glm-5.2:cloud" },
      { provider: "Ollama", id: "glm-5.2:cloud" },
    ],
    { provider: "Ollama", id: "glm-5.2:cloud" },
  );
  strictEqual(pick, undefined, "an identical duplicate is not a fallback");
});
