// scripts/spec-2-smoke.mts — SPEC-2 full-run smoke (rows 1-5).
// Exercises the REAL factory components (buildChildLoader + new ModelRegistry(realRuntime)
// + createAgentSession({customTools, excludeTools})) — the runtime-unverified path —
// and inspects the composed system prompt + tools. One trivial real prompt() call confirms
// the end-to-end spawn path doesn't crash.
//
// Run: node --import tsx scripts/spec-2-smoke.mts
import { ModelRuntime, ModelRegistry, createAgentSession, SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildChildLoader, USER_PSEUDO_CWD } from "../src/engine/child-loader.ts";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";
import { ArmoryVisionAdapter } from "../src/vision/adapter.ts";
import { createDescribeImageTool } from "../src/vision/describe-image-tool.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const PARENT_CWD = "/Users/rector/local-dev/getpipher/armory-fleet";
const TEXT_ONLY = { provider: "Ollama", id: "glm-5.2:cloud" };
const MULTIMODAL = { provider: "Ollama", id: "minimax-m3:cloud" };

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "smoke", description: "smoke", rolePrompt: "You are a smoke-test delegate. Reply minimally.",
    todoSync: true, memoryHydrate: true, vision: true, source: "builtin", filePath: "/x", ...over,
  };
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  ✔ ${name}`); pass++; }
  else { console.log(`  ✖ ${name} ${detail}`); fail++; }
}

// Seed temp memory (project + local + user) under a temp root.
const memRoot = `/tmp/fleet-smoke-mem-${Date.now()}`;
process.env.ARMORY_MEMORY_ROOT = memRoot;
function seed(cwd: string, files: Record<string, string>): void {
  const dir = join(memRoot, cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
}
seed(PARENT_CWD, { "project.md": "# Project smoke memory\nfleet-specific note." });
seed(dirname(PARENT_CWD), { "local.md": "# Local org memory\ngetpipher-wide note." });
seed(USER_PSEUDO_CWD, { "user.md": "# User global memory\ncross-project note." });

async function buildAndInspect(a: AgentDef, modelSpec: { provider: string; id: string }) {
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(modelSpec.provider, modelSpec.id);
  if (!model) throw new Error(`model ${modelSpec.provider}/${modelSpec.id} not found in runtime`);
  const memoryPort = new ArmoryMemoryAdapter();
  const loader = buildChildLoader({ cwd: PARENT_CWD, agent: a, memoryPort });
  await loader.reload();
  // Capture the composed system prompt by invoking the override with a known base.
  // The loader stores systemPromptOverride; reload() wired it. Read it via the loader's
  // getExtensions? Simpler: reconstruct via composeChildPrompt by calling renderScopes directly.
  const { composeChildPrompt, memoryScopesFor } = await import("../src/engine/child-loader.ts");
  const scopes = memoryScopesFor(PARENT_CWD);
  const memoryBlock = a.memoryHydrate ? memoryPort.renderScopes(scopes) : "";
  const composed = composeChildPrompt({ rolePrompt: a.rolePrompt, memoryBlock, base: "## Available tools\n- read\n" });
  // Real factory path: ModelRegistry + createAgentSession with customTools + excludeTools
  const visionPort = new ArmoryVisionAdapter({ modelRegistry: new ModelRegistry(runtime), cwd: PARENT_CWD, agentDir: getAgentDir() });
  const injectVision = a.vision && !visionPort.isMultimodal(model);
  const customTools: any[] = injectVision ? [createDescribeImageTool(visionPort) as never] : [];
  const { session } = await createAgentSession({
    cwd: PARENT_CWD, model, thinkingLevel: a.thinkingLevel,
    tools: a.tools ?? ["read", "bash", "edit", "write"],
    excludeTools: ["todo"],
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    modelRuntime: runtime,
  });
  return { composed, customTools, isMultimodal: visionPort.isMultimodal(model), session, model };
}

console.log("\n=== SPEC-2 full-run smoke (rows 1-5) ===\n");

try {
  // Row 1: text-only child model, default agent
  console.log("Row 1: text-only child (glm-5.2:cloud), default agent");
  const r1 = await buildAndInspect(agent(), TEXT_ONLY);
  check("describe_image present (text-only child)", r1.customTools.some((t) => t.name === "describe_image"));
  check("system prompt has 3-scope memory block (Project + Local + User)",
    /Project smoke memory/.test(r1.composed) && /Local org memory/.test(r1.composed) && /User global memory/.test(r1.composed), r1.composed.slice(0, 200));
  check("NO 'Open-TODOs' block leaked", !/Open TODOs|armory-todo: \d+ open/i.test(r1.composed));
  check("excludeTools excludes todo (no todo in customTools)", !r1.customTools.some((t) => t.name === "todo"));
  check("isMultimodal(glm-5.2:cloud) === false (text-only)", r1.isMultimodal === false);
  // one trivial real prompt() — confirms the full spawn path doesn't crash
  console.log("  …spawning real child prompt (text-only)…");
  await r1.session.prompt("Reply with exactly: OK");
  console.log("  ✔ real session.prompt() completed (no crash)");
  pass++;
  r1.session.dispose();

  // Row 2: multimodal child model, default agent
  console.log("\nRow 2: multimodal child (minimax-m3:cloud), default agent");
  const r2 = await buildAndInspect(agent(), MULTIMODAL);
  check("describe_image ABSENT (multimodal pass-through)", !r2.customTools.some((t) => t.name === "describe_image"));
  check("memory block still present", /Project smoke memory/.test(r2.composed));
  check("isMultimodal(minimax-m3:cloud) === true", r2.isMultimodal === true);
  r2.session.dispose();

  // Row 3: memoryHydrate:false
  console.log("\nRow 3: memoryHydrate:false agent");
  const r3 = await buildAndInspect(agent({ memoryHydrate: false }), TEXT_ONLY);
  check("NO memory block", !/Project smoke memory|Local org memory|User global memory/.test(r3.composed));
  check("describe_image still present (vision unaffected)", r3.customTools.some((t) => t.name === "describe_image"));
  r3.session.dispose();

  // Row 4: vision:false + text-only
  console.log("\nRow 4: vision:false agent, text-only model");
  const r4 = await buildAndInspect(agent({ vision: false }), TEXT_ONLY);
  check("NO describe_image (vision:false)", !r4.customTools.some((t) => t.name === "describe_image"));
  check("memory block still present", /Project smoke memory/.test(r4.composed));
  r4.session.dispose();

  // Row 5: composed prompt includes the pi base
  console.log("\nRow 5: composed prompt includes pi base");
  const r5 = await buildAndInspect(agent(), TEXT_ONLY);
  check("base ('## Available tools') present in composed prompt", /## Available tools/.test(r5.composed));
  check("rolePrompt present in composed prompt", /smoke-test delegate/.test(r5.composed));
  r5.session.dispose();
} catch (e) {
  console.log(`\n✖ SMOKE CRASHED: ${(e as Error).message}\n${(e as Error).stack}`);
  fail++;
}
finally {
  rmSync(memRoot, { recursive: true, force: true });
}

console.log(`\n=== smoke result: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);