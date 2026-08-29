import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory } from "../src/index.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

let tmpDir: string;
let resumeRoot: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-pi-factory-"));
  resumeRoot = mkdtempSync(join(tmpdir(), "fleet-pi-resume-"));
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

test("Pi factory emits session_init with a non-empty backendSessionId + persists to resume-store", async () => {
  const runtime = await ModelRuntime.create();
  const factory = createChildSessionFactory(runtime, new ArmoryMemoryAdapter(), new ResumeStore());
  const { session } = await factory.create({
    cwd: tmpDir, model: undefined, thinkingLevel: undefined, tools: ["read"], rolePrompt: "role",
    skills: [], task: "t", agent: agent(), memoryPort: new ArmoryMemoryAdapter(),
    visionPort: { isMultimodal: () => true, isConfigured: () => true, delegate: async () => ({ ok: false }) } as any,
  });
  let captured: string | undefined;
  session.subscribe((e: any) => { if (e.type === "session_init") captured = e.backendSessionId; });
  ok(captured && captured.length > 0, "session_init emitted with a backendSessionId");
  strictEqual(new ResumeStore().get("pi", "g"), captured);
  session.dispose();
});