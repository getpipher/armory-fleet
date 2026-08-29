import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, rejects } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeChildFactory } from "../src/backend/claude-factory.ts";
import { ResumeStore } from "../src/backend/resume-store.ts";
import type { BackendVersionInfo } from "../src/backend/registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";
import type { ChildSessionOpts } from "../src/engine/spawnSubagent.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude-stream.mjs");
const healthy: BackendVersionInfo = { version: "1.0.17", schemaOk: true, flagSupport: { "--disallowed-tools": true, "--allowed-tools": true, "--max-turns": true, "--resume": true, "--append-system-prompt": true, "--output-format": true } };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet-cc-factory-")); process.env.FLEET_RESUME_ROOT = root; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.FLEET_RESUME_ROOT; });

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: "cc", description: "d", rolePrompt: "you are cc", todoSync: true, memoryHydrate: true, vision: true, userMemory: false,
  backend: "claude", sessionKey: "cc", source: "builtin", filePath: "/x", ...over,
});

const opts = (over: Partial<ChildSessionOpts> = {}): ChildSessionOpts => ({
  cwd: "/tmp", model: "claude-sonnet-4-5", thinkingLevel: undefined as any, tools: ["read", "bash"], rolePrompt: "you are cc",
  skills: [], task: "do it", agent: agent(), memoryPort: { renderScopes: () => "MEMBLOCK" } as any,
  visionPort: { isMultimodal: () => true, isConfigured: () => true, delegate: async () => ({ ok: false }) } as any, ...over,
});

test("throws if detector says schemaOk false", async () => {
  const f = createClaudeChildFactory({ ...healthy, schemaOk: false, note: "drift" }, new ResumeStore(), fakeBin);
  await rejects(() => f.create(opts()), /claude backend unavailable.*drift/i);
});

test("passes --append-system-prompt with the memory block + role prompt", async () => {
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, new ResumeStore(), process.execPath, {
    spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; },
  });
  try { await f.create(opts()); } catch { /* stub session may throw on prompt; args captured above */ }
  ok(seen.length > 0);
  ok(seen[0]!.includes("--append-system-prompt"));
  ok(seen[0]!.includes("MEMBLOCK"));
  ok(seen[0]!.includes("--disallowed-tools"));
  ok(seen[0]!.includes("todo"));
});

test("passes --resume <id> when resumeStore has one for sessionKey", async () => {
  const rs = new ResumeStore();
  rs.set("claude", "cc", "prior-sess-id");
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, rs, process.execPath, { spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; } });
  try { await f.create(opts()); } catch { /* captured */ }
  ok(seen[0]!.includes("--resume prior-sess-id"));
});

test("omits --resume when resumeStore has no entry", async () => {
  const seen: string[] = [];
  const f = createClaudeChildFactory(healthy, new ResumeStore(), process.execPath, { spawnOverride: (args) => { seen.push(args.join(" ")); return null as any; } });
  try { await f.create(opts()); } catch { /* captured */ }
  ok(!/--resume/.test(seen[0]!));
});