import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, match } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory, formatAvailableModels } from "../src/index.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
let resumeRoot: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-57-"));
  resumeRoot = mkdtempSync(join(tmpdir(), "fleet-57-resume-"));
  process.env.FLEET_RESUME_ROOT = resumeRoot;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(resumeRoot, { recursive: true, force: true });
  delete process.env.FLEET_RESUME_ROOT;
});

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "g", description: "d", rolePrompt: "role", todoSync: true, memoryHydrate: true, vision: true, userMemory: false,
  backend: "pi", sessionKey: "g", source: "builtin", filePath: "/x", ...over,
});

// #57: a bad `model` param must error with the session's usable models so the
// orchestrating model can self-correct on the retry instead of failing opaquely.

test("formatAvailableModels: provider/id list, dedup, cap with +N more", () => {
  const models = [
    { provider: "Ollama", id: "glm-5.2:cloud" },
    { provider: "Ollama", id: "glm-5.2:cloud" }, // dup
    { provider: "Ollama", id: "minimax-m3:cloud" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  strictEqual(
    formatAvailableModels(models as never[], 12),
    "Ollama/glm-5.2:cloud, Ollama/minimax-m3:cloud, openai-codex/gpt-5.6-sol",
  );
  const many = Array.from({ length: 15 }, (_, i) => ({ provider: "p", id: `m${i}` }));
  const capped = formatAvailableModels(many as never[], 10);
  ok(capped.includes("p/m9"), "lists up to the cap");
  ok(!capped.includes("p/m10"), "stops at the cap");
  match(capped, /\+5 more$/);
});

test("formatAvailableModels: cap below 1 clamps to 1 (non-empty input always lists something)", () => {
  const models = [{ provider: "p", id: "m0" }, { provider: "p", id: "m1" }];
  strictEqual(formatAvailableModels(models as never[], 0), "p/m0 … +1 more");
});

test("formatAvailableModels: empty snapshot → actionable none-hint", () => {
  strictEqual(formatAvailableModels([], 12), "(none — check provider auth / models.json)");
});

test("factory: unknown model param errors listing available models", async () => {
  const runtime = await ModelRuntime.create();
  const factory = createChildSessionFactory(runtime, new ArmoryMemoryAdapter(), new ResumeStore());
  let err: Error | undefined;
  try {
    await factory.create({
      cwd: tmpDir, model: "acme/definitely-not-a-real-model", thinkingLevel: undefined, tools: ["read"], rolePrompt: "role",
      skills: [], task: "t", agent: agent(), memoryPort: new ArmoryMemoryAdapter(),
      visionPort: { isMultimodal: () => true, isConfigured: () => true, delegate: async () => ({ ok: false }) } as any,
    });
  } catch (e) {
    err = e as Error;
  }
  ok(err, "create rejects on an unknown model");
  match(err.message, /agent model 'acme\/definitely-not-a-real-model' not found in runtime/);
  match(err.message, /Available: /, "error lists the session's available models");
  // At least one usable provider/id pair from the real runtime snapshot appears in the message.
  // Tail assertion is environment-conditional: a clean CI runner has zero configured
  // providers (no env keys, no auth.json) → empty snapshot → the error carries the
  // actionable none-hint instead of model refs (review CRITICAL on PR #75).
  const listed = runtime.getAvailableSnapshot();
  if (listed.length === 0) {
    ok(err.message.includes("(none — check provider auth"), "empty snapshot → actionable auth hint");
  } else {
    const firstModel = listed[0];
    ok(firstModel, "snapshot entry defined");
    const first = `${firstModel.provider}/${firstModel.id}`;
    ok(err.message.includes(first), `error mentions a real available model (${first})`);
  }
});
