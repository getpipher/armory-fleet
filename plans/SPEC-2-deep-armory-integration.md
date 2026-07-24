# SPEC-2 — Deep armory integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every fleet-spawned subagent memory-hydrated (three-scope) and vision-capable (capability-aware) by deliberate fleet construction via a `CustomResourceLoader` + ports-and-adapters, completing the child-side moat.

**Architecture:** A fleet-owned `CustomResourceLoader` (promoting SPEC-1's `DefaultResourceLoader`-with-overrides) takes deliberate control of the child's extension set (`noExtensions: true`), system prompt (composed `rolePrompt + memoryBlock + base`), and tools (`excludeTools: ["todo"]` + conditional `customTools`). Two ports (`MemoryHydratePort`, `VisionPort`) decouple fleet core from the sibling packages; two adapters are the sole importers. Two companion PRs add `exports` + `.d.ts` to armory-memory and vision (same shape as the SPEC-1 armory-todo companion PRs #12/#13). Cursor is deferred to SPEC-5b.

**Tech Stack:** TypeScript (raw `.ts` via tsx, no build), pi `^0.81.1` SDK (`createAgentSession`, `DefaultResourceLoader`, `ModelRuntime`, `SessionManager.inMemory`), `node:test` via tsx, `@getpipher/armory-memory`, `@getpipher/vision`, `typebox`.

## Global Constraints

- **No build step** — raw `.ts` via tsx at runtime; `pnpm typecheck` + `pnpm test:run` (node:test via tsx) before release.
- **Test runner:** `node --import tsx --test test/*.test.mts` (Node 24 won't type-strip under `node_modules`).
- **pi target:** `^0.81.1`. SDK imports from `@earendil-works/pi-coding-agent`; types from `@earendil-works/pi-ai` (`Model`), `typebox` for tool schemas.
- **Ports-and-adapters:** fleet core (engine, loader, tool, panel) depends only on `*Port` interfaces; `Armory*Adapter` is the sole importer of each sibling. Zero sibling types in core.
- **Single-writer discipline:** `noExtensions: true` on the child loader (no host extension hooks fire in the child); `excludeTools: ["todo"]` (hardened guard).
- **No AI attribution** in commits/PRs/files.
- **One commit per task**; conventional branch `feat/spec-2-deep-armory-integration`.
- **getpither conventions:** EditorTheme gotcha — `ctx.ui.custom` receives full `Theme` (import from `@earendil-works/pi-coding-agent`); `ctx.ui.setEditorComponent` receives `EditorTheme`. Thread `() => ctx.ui.theme` for real colors.
- **Companion PRs land first** (Tasks 1–2) so fleet's `pnpm install` against `file:../armory-memory` + `file:../vision` resolves the new `exports`.

---

## File Structure

**Fleet (this repo):**
- `src/memory-hydrate/port.ts` — `MemoryHydratePort` interface + `MemoryScopes`
- `src/memory-hydrate/adapter.ts` — `ArmoryMemoryAdapter` (only `@getpipher/armory-memory` importer)
- `src/vision/port.ts` — `VisionPort` interface
- `src/vision/adapter.ts` — `ArmoryVisionAdapter` (only `@getpipher/vision` importer)
- `src/vision/describe-image-tool.ts` — fleet-defined `describe_image` tool (thin wrapper over `VisionPort.delegate`)
- `src/engine/child-loader.ts` — the `CustomResourceLoader` builder (`noExtensions` + composed `systemPromptOverride` + `skillsOverride`)
- `src/engine/spawnSubagent.ts` — **modify**: thread ports, `excludeTools`, `customTools`
- `src/registry/frontmatter.ts` — **modify**: add `memoryHydrate` + `vision` fields
- `src/panel/rows.ts` — **modify**: armory chip + `agentInfo` content
- `src/panel/fleet-panel.ts` — **modify**: `i:Info` action + detail pane
- `src/index.ts` — **modify**: wire `ArmoryMemoryAdapter` + `ArmoryVisionAdapter` into deps; pass to factory
- `agents/general-purpose.md` — **modify**: explicit `memoryHydrate: true` + `vision: true`
- `test/memory-hydrate-adapter.test.mts`, `test/vision-adapter.test.mts`, `test/describe-image-tool.test.mts`, `test/child-loader.test.mts`, `test/frontmatter-spec2.test.mts`, `test/spawn-subagent-spec2.test.mts`, `test/panel-spec2.test.mts`
- `docs/SPEC-2-smoke-checklist.md` — the 5-row real-pi smoke matrix

**Companion PRs (sibling repos):**
- `~/local-dev/getpipher/armory-memory/` — `exports` map + `src/index.ts` + `src/index.d.ts`
- `~/local-dev/getpipher/vision/` — `exports` map + `src/index.ts` + `src/index.d.ts` + `createVisionDelegator`

---

## Task 1: Companion PR — armory-memory public API

**Repo:** `~/local-dev/getpipher/armory-memory` (branch `feat/exports-surface` → PR to armory-memory main)
**Mirrors:** armory-todo PRs #12 (`exports` + `index.ts`) + #13 (`index.d.ts` + dual-condition exports).

**Files:**
- Modify: `~/local-dev/getpipher/armory-memory/package.json` (add `exports` + `types`)
- Create: `~/local-dev/getpipher/armory-memory/src/index.ts`
- Create: `~/local-dev/getpipher/armory-memory/src/index.d.ts`
- Create: `~/local-dev/getpipher/armory-memory/test/exports.test.mts`

**Interfaces:**
- Produces: `@getpipher/armory-memory` public surface — `renderMemoryBlock(cwd: string, opts?: InjectOptions): string`, `listMemory(cwd: string): MemoryFile[]`, `memoryDirFor(cwd: string): string`, `toSlug(cwd: string): string`, `fromSlug(slug: string): string`, plus types `MemoryFile`, `InjectOptions`.

- [ ] **Step 1: Write the failing test**

`test/exports.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMemoryBlock, listMemory, memoryDirFor, toSlug } from "../src/index.ts";

test("exports surface re-exports the pure store functions", () => {
  assert.equal(typeof renderMemoryBlock, "function");
  assert.equal(typeof listMemory, "function");
  assert.equal(typeof memoryDirFor, "function");
  assert.equal(typeof toSlug, "function");
});

test("toSlug is reachable via the public surface", () => {
  assert.equal(toSlug("/Users/x/proj"), "-Users-x-proj");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/local-dev/getpipher/armory-memory && node --import tsx --test test/exports.test.mts`
Expected: FAIL — `Cannot find module '../src/index.ts'`

- [ ] **Step 3: Create `src/index.ts` (stable re-export)**

```ts
// src/index.ts — public stable surface for @getpipher/armory-memory.
// src/memory-store.ts remains the implementation; this file is the typed seam
// consumers (e.g. @getpipher/armory-fleet) depend on.
export {
  renderMemoryBlock,
  listMemory,
  memoryDirFor,
  toSlug,
  fromSlug,
  importProject,
  importAll,
  discoverCCProjects,
  PI_MEMORY_ROOT,
  CC_PROJECTS_ROOT,
  type MemoryFile,
  type InjectOptions,
  type ImportResult,
} from "./memory-store.ts";
```

- [ ] **Step 4: Create `src/index.d.ts` (dual-condition types)**

```ts
// src/index.d.ts — typed declaration mirroring src/index.ts.
export {
  renderMemoryBlock,
  listMemory,
  memoryDirFor,
  toSlug,
  fromSlug,
  importProject,
  importAll,
  discoverCCProjects,
  PI_MEMORY_ROOT,
  CC_PROJECTS_ROOT,
  type MemoryFile,
  type InjectOptions,
  type ImportResult,
} from "./memory-store.ts";
```

- [ ] **Step 5: Add `exports` + `types` to `package.json`**

Replace the `package.json` block (preserve name/version/scripts):
```json
{
  "name": "@getpipher/armory-memory",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.d.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "node --import tsx --test test/*.test.mts"
  }
}
```
(Keep existing deps/license/keywords; only add `exports` + ensure `type: module`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ~/local-dev/getpipher/armory-memory && node --import tsx --test test/exports.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the existing suite to confirm no regression**

Run: `cd ~/local-dev/getpipher/armory-memory && node --import tsx --test test/*.test.mts`
Expected: PASS (existing memory-store tests + new exports test)

- [ ] **Step 8: Commit + push + open PR**

```bash
cd ~/local-dev/getpipher/armory-memory
git checkout -b feat/exports-surface
git add package.json src/index.ts src/index.d.ts test/exports.test.mts
git commit -m "feat: add exports surface (index.ts + index.d.ts) for typed consumers"
git push -u origin feat/exports-surface
gh pr create --title "feat: add exports surface for typed consumers" --body "Mirrors armory-todo #12/#13. Adds exports map + src/index.ts re-exporting the pure memory-store functions + src/index.d.ts for TS consumers (dual-condition: types→.d.ts, default→.ts). Additive, no behavior change." --base main
```

**Gate:** merge the armory-memory PR before Task 7 (fleet `pnpm install` against `file:../armory-memory` needs the new `exports`).

---

## Task 2: Companion PR — vision public API + `createVisionDelegator`

**Repo:** `~/local-dev/getpipher/vision` (branch `feat/exports-surface` → PR to vision main)

**Files:**
- Modify: `~/local-dev/getpipher/vision/package.json` (add `exports`)
- Create: `~/local-dev/getpipher/vision/src/index.ts`
- Create: `~/local-dev/getpipher/vision/src/index.d.ts`
- Modify: `~/local-dev/getpipher/vision/lib/delegate.ts` (add `createVisionDelegator`)
- Create: `~/local-dev/getpipher/vision/test/delegator.test.mts`

**Interfaces:**
- Produces: `@getpipher/vision` public surface — `isMultimodal(model)`, `loadConfig(agentDir)`, `createVisionDelegator(deps)`, types `VisionConfig`, `DelegateParams`, `DelegateResult`.
- `createVisionDelegator({ modelRuntime, cwd, agentDir }): { delegate(params, signal?): Promise<DelegateResult>, config: VisionConfig }` — encapsulates the `ModelRuntime → modelRegistry` adaptation inside vision (where `ModelRegistry` knowledge lives), so fleet never builds an `ExtensionContext`.

- [ ] **Step 1: Verify the `ModelRegistry` → `ModelRuntime` adaptation surface**

Run:
```bash
PI_SRC=/Users/rector/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist
sed -n '1,60p' "$PI_SRC/core/model-registry.d.ts"
grep -n "getApiKeyAndHeaders\|find" "$PI_SRC/core/model-registry.d.ts"
grep -n "getAuth\b" "$PI_SRC/core/model-runtime.d.ts"
```
Read the output. `delegateToVisionModel` uses `ctx.modelRegistry.find(provider, model)` + `ctx.modelRegistry.getApiKeyAndHeaders(model)`. `ModelRuntime` has `getModel(providerId, modelId)` (≈ `find`) and `getAuth(model, overrides): Promise<AuthResult>`. Determine from `model-registry.d.ts` exactly what `getApiKeyAndHeaders` returns (likely `{ ok, apiKey, headers }`) and map `ModelRuntime.getAuth` → that shape in the adapter shim below. Record the exact mapping in a comment.

- [ ] **Step 2: Write the failing test**

`test/delegator.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMultimodal, loadConfig, createVisionDelegator } from "../src/index.ts";

test("isMultimodal + loadConfig + createVisionDelegator are exported", () => {
  assert.equal(typeof isMultimodal, "function");
  assert.equal(typeof loadConfig, "function");
  assert.equal(typeof createVisionDelegator, "function");
});

test("createVisionDelegator returns a delegator with config + delegate fn", () => {
  const fakeRuntime = {
    getModel: () => undefined,
    getAuth: async () => undefined,
  };
  const d = createVisionDelegator({ modelRuntime: fakeRuntime as any, cwd: "/tmp", agentDir: "/tmp" });
  assert.equal(typeof d.delegate, "function");
  assert.equal(typeof d.config, "object");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/local-dev/getpipher/vision && npx tsx --test test/delegator.test.mts`
Expected: FAIL — `Cannot find module '../src/index.ts'`

- [ ] **Step 4: Add `createVisionDelegator` to `lib/delegate.ts`**

Append to `lib/delegate.ts` (after the existing `delegateToVisionModel`):
```ts
// ── ModelRuntime-backed delegator (for non-extension consumers like armory-fleet).
// Encapsulates the ModelRuntime → { modelRegistry, cwd } adaptation inside vision,
// so consumers don't construct an ExtensionContext.
export interface VisionDelegatorDeps {
  /** Minimal ModelRuntime slice: find a model + resolve its auth headers. */
  modelRuntime: {
    getModel(providerId: string, modelId: string): Model<Api> | undefined;
    getAuth(model: Model<Api>, overrides?: Record<string, unknown>): Promise<unknown>;
  };
  cwd: string;
  agentDir: string;
}
export interface VisionDelegator {
  delegate(params: DelegateParams, signal?: AbortSignal | undefined): Promise<DelegateResult>;
  config: VisionConfig;
}

/** Adapt a ModelRuntime slice to the { modelRegistry, cwd } shape delegateToVisionModel reads. */
function adaptRuntimeToCtx(deps: VisionDelegatorDeps): { modelRegistry: any; cwd: string } {
  // Map ModelRuntime.getAuth → getApiKeyAndHeaders. Verify the exact return shape
  // against dist/core/model-registry.d.ts (getApiKeyAndHeaders) at impl time;
  // the AuthResult from getAuth carries the apiKey + headers delegateToVisionModel needs.
  // (Step 1 of this task records the precise mapping.)
  return {
    cwd: deps.cwd,
    modelRegistry: {
      find: (provider: string, id: string) => deps.modelRuntime.getModel(provider, id),
      getApiKeyAndHeaders: async (model: Model<Api>) => {
        const auth = await deps.modelRuntime.getAuth(model) as any;
        if (!auth || !auth.ok) return { ok: false, error: auth?.error ?? "auth unresolved" };
        return { ok: true, apiKey: auth.apiKey, headers: auth.headers ?? {} };
      },
    },
  };
}

export function createVisionDelegator(deps: VisionDelegatorDeps): VisionDelegator {
  const config = loadConfig(deps.agentDir);
  const ctx = adaptRuntimeToCtx(deps);
  return {
    config,
    delegate: (params, signal) => delegateToVisionModel(ctx as any, config, params, signal),
  };
}
```
(Adjust the `getApiKeyAndHeaders` mapping per Step 1's finding. The interface + approach are fixed; only the auth-shape mapping is impl-verified.)

- [ ] **Step 5: Create `src/index.ts` + `src/index.d.ts`**

`src/index.ts`:
```ts
export { isMultimodal, TOOL_NAME } from "../lib/capability.ts";
export { loadConfig, configFilePath } from "../lib/config.ts";
export {
  delegateToVisionModel,
  createVisionDelegator,
  type DelegateParams,
  type DelegateResult,
  type DelegateSuccess,
  type DelegateFailure,
  type VisionDelegator,
  type VisionDelegatorDeps,
} from "../lib/delegate.ts";
export type { VisionConfig } from "../lib/config.ts";
```
`src/index.d.ts`: mirror the same exports (dual-condition: `types`→.d.ts, `default`→.ts).

- [ ] **Step 6: Add `exports` to `package.json`**

```json
"exports": { ".": { "types": "./src/index.d.ts", "default": "./src/index.ts" } },
"type": "module",
```

- [ ] **Step 7: Run tests to verify pass**

Run: `cd ~/local-dev/getpipher/vision && npx tsx --test test/delegator.test.mts && pnpm typecheck && pnpm test:run`
Expected: PASS (delegator tests + existing 203-test suite green; typecheck clean)

- [ ] **Step 8: Commit + push + open PR**

```bash
cd ~/local-dev/getpipher/vision
git checkout -b feat/exports-surface
git add package.json src/index.ts src/index.d.ts lib/delegate.ts test/delegator.test.mts
git commit -m "feat: add exports surface + createVisionDelegator for non-extension consumers"
git push -u origin feat/exports-surface
gh pr create --title "feat: exports surface + createVisionDelegator" --body "Mirrors armory-todo #12/#13. Adds exports map + src/index.ts re-exporting capability/delegate/config pure functions + src/index.d.ts. Adds createVisionDelegator({modelRuntime,cwd,agentDir}) so consumers with a ModelRuntime (e.g. armory-fleet) can delegate without constructing an ExtensionContext. Additive." --base main
```

**Gate:** merge the vision PR before Task 7.

---

## Task 3: `MemoryHydratePort` + `ArmoryMemoryAdapter`

**Files:**
- Create: `src/memory-hydrate/port.ts`
- Create: `src/memory-hydrate/adapter.ts`
- Create: `test/memory-hydrate-adapter.test.mts`

**Interfaces:**
- Consumes: `@getpipher/armory-memory` `renderMemoryBlock`, `listMemory` (Task 1's exports).
- Produces: `MemoryHydratePort` (`renderScopes(scopes) → string`), `ArmoryMemoryAdapter`.

- [ ] **Step 1: Write the failing test**

`test/memory-hydrate-adapter.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ArmoryMemoryAdapter } from "../src/memory-hydrate/adapter.ts";

function seed(root: string, cwd: string, files: Record<string, string>): void {
  const dir = join(root, cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

test("renderScopes concatenates non-empty scopes in project → local → user order", () => {
  const root = `/tmp/armory-mem-test-${Date.now()}`;
  process.env.ARMORY_MEMORY_ROOT = root;
  seed(root, "/proj", { "p.md": "# Project\nproj body" });
  seed(root, "/parent", { "l.md": "# Local\nlocal body" });
  seed(root, "/__armory-fleet-user__", { "u.md": "# User\nuser body" });
  try {
    const adapter = new ArmoryMemoryAdapter();
    const block = adapter.renderScopes({ project: "/proj", local: "/parent", user: "/__armory-fleet-user__" });
    const pIdx = block.indexOf("Project");
    const lIdx = block.indexOf("Local");
    const uIdx = block.indexOf("User");
    assert.ok(pIdx >= 0 && lIdx > pIdx && uIdx > lIdx, "project before local before user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderScopes returns empty string when all scopes empty", () => {
  const root = `/tmp/armory-mem-empty-${Date.now()}`;
  process.env.ARMORY_MEMORY_ROOT = root;
  try {
    const adapter = new ArmoryMemoryAdapter();
    assert.equal(adapter.renderScopes({ project: "/none", local: "/none2", user: "/none3" }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/memory-hydrate-adapter.test.mts`
Expected: FAIL — `Cannot find module '../src/memory-hydrate/adapter.ts'`

- [ ] **Step 3: Create `src/memory-hydrate/port.ts`**

```ts
// src/memory-hydrate/port.ts — fleet-owned port; fleet core depends only on this.
export interface MemoryScopes {
  /** The cwd the child works in (= parentCwd in SPEC-2; the project cwd at SPEC-5a worktree). */
  project: string;
  /** Immediate parent directory of the project cwd (workspace/org level). */
  local: string;
  /** Fixed pseudo-cwd for global cross-project user memory. */
  user: string;
}
export interface MemoryHydratePort {
  /** Render the three-scope memory block (project → local → user), concatenated. Empty when all scopes empty. */
  renderScopes(scopes: MemoryScopes): string;
}
```

- [ ] **Step 4: Create `src/memory-hydrate/adapter.ts`**

```ts
// src/memory-hydrate/adapter.ts — ONLY file importing @getpipher/armory-memory.
import { renderMemoryBlock, listMemory } from "@getpipher/armory-memory";
import type { MemoryHydratePort, MemoryScopes } from "./port.ts";

export class ArmoryMemoryAdapter implements MemoryHydratePort {
  renderScopes(scopes: MemoryScopes): string {
    return [scopes.project, scopes.local, scopes.user]
      .filter((cwd) => listMemory(cwd).length > 0)   // skip empty scopes cleanly
      .map((cwd) => renderMemoryBlock(cwd))
      .join("\n\n");                                  // → "" when all three empty
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/memory-hydrate-adapter.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/memory-hydrate/port.ts src/memory-hydrate/adapter.ts test/memory-hydrate-adapter.test.mts
git commit -m "feat(spec-2): MemoryHydratePort + ArmoryMemoryAdapter (three-scope hydration)"
```

---

## Task 4: `VisionPort` + `ArmoryVisionAdapter`

**Files:**
- Create: `src/vision/port.ts`
- Create: `src/vision/adapter.ts`
- Create: `test/vision-adapter.test.mts`

**Interfaces:**
- Consumes: `@getpipher/vision` `isMultimodal`, `loadConfig`, `createVisionDelegator` (Task 2's exports); fleet's `ModelRuntime` + `getAgentDir()`.
- Produces: `VisionPort` (`isMultimodal(model)`, `delegate(params, signal?)`, `isConfigured()`).

- [ ] **Step 1: Write the failing test**

`test/vision-adapter.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArmoryVisionAdapter } from "../src/vision/adapter.ts";

test("isMultimodal delegates to vision's isMultimodal", () => {
  const adapter = new ArmoryVisionAdapter({
    getModel: () => undefined,
    getAuth: async () => undefined,
  } as any, "/tmp", "/tmp");
  assert.equal(adapter.isMultimodal(undefined), false);
  assert.equal(adapter.isMultimodal({ input: ["text", "image"] } as any), true);
  assert.equal(adapter.isMultimodal({ input: ["text"] } as any), false);
});

test("isConfigured reflects loadConfig", () => {
  const adapter = new ArmoryVisionAdapter({
    getModel: () => undefined,
    getAuth: async () => undefined,
  } as any, "/tmp", "/tmp");
  assert.equal(typeof adapter.isConfigured(), "boolean");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/vision-adapter.test.mts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/vision/port.ts`**

```ts
// src/vision/port.ts — fleet-owned port; fleet core depends only on this.
import type { Model } from "@earendil-works/pi-ai";
export interface VisionDelegateParams {
  /** Absolute path to the image file the child read. */
  imagePath: string;
  /** Optional analysis prompt. */
  prompt?: string;
}
export type VisionDelegateResult = { ok: true; text: string } | { ok: false; error: string };
export interface VisionPort {
  isMultimodal(model: Model<any> | undefined): boolean;
  delegate(params: VisionDelegateParams, signal?: AbortSignal): Promise<VisionDelegateResult>;
  /** Whether a vision model is configured in the host vision.json. */
  isConfigured(): boolean;
}
```

- [ ] **Step 4: Create `src/vision/adapter.ts`**

```ts
// src/vision/adapter.ts — ONLY file importing @getpipher/vision.
import { isMultimodal, createVisionDelegator, type VisionConfig, type DelegateResult } from "@getpipher/vision";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import type { VisionPort, VisionDelegateParams, VisionDelegateResult } from "./port.ts";

/** Minimal ModelRuntime slice the adapter needs. */
export interface VisionModelRuntime {
  getModel(providerId: string, modelId: string): Model<any> | undefined;
  getAuth(model: Model<any>, overrides?: Record<string, unknown>): Promise<unknown>;
}

export class ArmoryVisionAdapter implements VisionPort {
  private readonly delegator: ReturnType<typeof createVisionDelegator>;
  constructor(modelRuntime: VisionModelRuntime, cwd: string, agentDir: string) {
    this.delegator = createVisionDelegator({ modelRuntime, cwd, agentDir });
  }
  isMultimodal(model: Model<any> | undefined): boolean {
    return isMultimodal(model);
  }
  isConfigured(): boolean {
    const c = this.delegator.config as VisionConfig;
    return Boolean(c.enabled && c.provider && c.model);
  }
  async delegate(params: VisionDelegateParams, signal?: AbortSignal): Promise<VisionDelegateResult> {
    if (!this.isConfigured()) {
      return { ok: false, error: "no vision model configured; run `/vision model <id>` in the host or set `vision: false` on this agent." };
    }
    const result: DelegateResult = await this.delegator.delegate(
      { image_path: params.imagePath, prompt: params.prompt ?? "", compress: true, reasoning: this.delegator.config.defaultReasoningEffort ?? "medium" },
      signal,
    );
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error.message };
  }
}
```
(If `defaultReasoningEffort` isn't the exact config field name, verify against `lib/config.ts` `VisionConfig` and adjust — the field is `reasoning`/`defaultReasoningEffort`; Step 4 of Task 2 exposed `VisionConfig` so tsc will catch a mismatch.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/vision-adapter.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/vision/port.ts src/vision/adapter.ts test/vision-adapter.test.mts
git commit -m "feat(spec-2): VisionPort + ArmoryVisionAdapter (capability-aware delegation)"
```

---

## Task 5: The fleet `describe_image` tool

**Files:**
- Create: `src/vision/describe-image-tool.ts`
- Create: `test/describe-image-tool.test.mts`

**Interfaces:**
- Consumes: `VisionPort` (Task 4).
- Produces: `createDescribeImageTool(visionPort)` → a pi `ToolDefinition` (the child's `describe_image`).

- [ ] **Step 1: Write the failing test**

`test/describe-image-tool.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDescribeImageTool } from "../src/vision/describe-image-tool.ts";

function fakePort(text: string): any {
  return {
    isMultimodal: () => false,
    isConfigured: () => true,
    delegate: async () => ({ ok: true, text }),
  };
}

test("describe_image tool delegates via VisionPort and returns text", async () => {
  const tool = createDescribeImageTool(fakePort("a cat sitting on a laptop"));
  const result = await tool.execute!("t1", { image: "/tmp/x.png" }, undefined, undefined, undefined as any);
  assert.equal(result.content[0].text, "a cat sitting on a laptop");
});

test("describe_image returns actionable error when not configured", async () => {
  const tool = createDescribeImageTool({ isMultimodal: () => false, isConfigured: () => false, delegate: async () => ({ ok: false, error: "no" }) } as any);
  const result = await tool.execute!("t1", { image: "/tmp/x.png" }, undefined, undefined, undefined as any) as any;
  assert.ok(result.isError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/describe-image-tool.test.mts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/vision/describe-image-tool.ts`**

```ts
// src/vision/describe-image-tool.ts — fleet-defined describe_image for child sessions.
// Mirrors @getpipher/vision's describe_image contract so user muscle memory transfers,
// but execute() delegates via VisionPort (vision's extension never loads into the child).
import { Type, type Static } from "typebox";
import type { VisionPort } from "./port.ts";

const Params = Type.Object({
  image: Type.String({ description: "Absolute path to the image file to analyze." }),
  prompt: Type.Optional(Type.String({ description: "Optional question/instruction for the analysis." })),
});
type P = Static<typeof Params>;

export function createDescribeImageTool(visionPort: VisionPort) {
  return {
    name: "describe_image",
    label: "Vision",
    description:
      "Analyze an image file and return a text description. Use when you read an image file and need to understand its contents. " +
      "Pass an absolute image path and an optional analysis prompt.",
    promptSnippet: "Analyze an image file and return a text description",
    inputSchema: Params,
    execute: async (_toolCallId: string, params: P, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
      const result = await visionPort.delegate({ imagePath: params.image, prompt: params.prompt });
      if (result.ok) {
        return { content: [{ type: "text" as const, text: result.text }] };
      }
      return { content: [{ type: "text" as const, text: result.error }], isError: true as const };
    },
  };
}
```
(Adjust the `execute` signature to match pi's `ToolDefinition` execute shape exactly — verify against `dist/core/extensions/types.d.ts` `ToolDefinition` / `AgentToolResult` at impl time. The `content: [{type:"text",text}]` + `isError` shape matches pi's tool-result convention per SPEC-1 §4.2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/describe-image-tool.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/vision/describe-image-tool.ts test/describe-image-tool.test.mts
git commit -m "feat(spec-2): fleet-defined describe_image tool (VisionPort delegation)"
```

---

## Task 6: The `CustomResourceLoader` builder (`child-loader.ts`)

**Files:**
- Create: `src/engine/child-loader.ts`
- Create: `test/child-loader.test.mts`

**Interfaces:**
- Consumes: `MemoryHydratePort` (Task 3), `VisionPort` (Task 4), `AgentDef` (existing `frontmatter.ts`), pi `DefaultResourceLoader`, `getAgentDir`.
- Produces: `buildChildLoader(opts)` → a `DefaultResourceLoader` configured with `noExtensions: true` + composed `systemPromptOverride` + `skillsOverride`; `composeChildPrompt({rolePrompt, memoryBlock, base})` (exported for unit testing); `USER_PSEUDO_CWD` constant.

- [ ] **Step 1: Write the failing test**

`test/child-loader.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeChildPrompt, USER_PSEUDO_CWD } from "../src/engine/child-loader.ts";

test("composeChildPrompt orders rolePrompt → memoryBlock → base, omitting empty memory", () => {
  const out = composeChildPrompt({ rolePrompt: "PERSONA", memoryBlock: "## Memory\nstuff", base: "## Tools\n..." });
  assert.equal(out, "PERSONA\n\n## Memory\nstuff\n\n## Tools\n...");
});

test("composeChildPrompt omits the memory block when empty", () => {
  const out = composeChildPrompt({ rolePrompt: "PERSONA", memoryBlock: "", base: "## Tools\n..." });
  assert.equal(out, "PERSONA\n\n## Tools\n...");
});

test("USER_PSEUDO_CWD is a stable sentinel", () => {
  assert.equal(USER_PSEUDO_CWD, "/__armory-fleet-user__");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/child-loader.test.mts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/engine/child-loader.ts`**

```ts
// src/engine/child-loader.ts — the fleet CustomResourceLoader builder.
// Promotes SPEC-1's DefaultResourceLoader-with-overrides to deliberate control:
// noExtensions (deterministic child, no host-extension leakage), composed
// systemPromptOverride (rolePrompt + memoryBlock + base), scoped skills.
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { AgentDef } from "../registry/frontmatter.ts";
import type { MemoryHydratePort } from "../memory-hydrate/port.ts";

/** Fixed pseudo-cwd for the global cross-project user memory scope. */
export const USER_PSEUDO_CWD = "/__armory-fleet-user__";

export interface ChildLoaderOpts {
  cwd: string;
  agent: AgentDef;
  memoryPort: MemoryHydratePort;
}

/** Compose the child system prompt: rolePrompt → memoryBlock → base (empty memoryBlock omitted). */
export function composeChildPrompt(args: { rolePrompt: string; memoryBlock: string; base: string }): string {
  const { rolePrompt, memoryBlock, base } = args;
  return [rolePrompt, memoryBlock, base].filter((s) => s && s.trim().length > 0).join("\n\n");
}

/** Build the three memory scopes for a child: project=cwd, local=parent dir, user=sentinel. */
export function memoryScopesFor(cwd: string): { project: string; local: string; user: string } {
  return { project: cwd, local: dirname(cwd) || cwd, user: USER_PSEUDO_CWD };
}

/** Build the fleet CustomResourceLoader for a child session. */
export function buildChildLoader(opts: ChildLoaderOpts): DefaultResourceLoader {
  const scopes = memoryScopesFor(opts.cwd);
  const memoryBlock = opts.agent.memoryHydrate ? opts.memoryPort.renderScopes(scopes) : "";
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    systemPromptOverride: (base: string) => composeChildPrompt({ rolePrompt: opts.agent.rolePrompt, memoryBlock, base }),
    skillsOverride: (cur: { skills: { name: string }[]; diagnostics: unknown }) => ({
      skills: opts.agent.skills && opts.agent.skills.length
        ? cur.skills.filter((s) => opts.agent.skills!.includes(s.name))
        : cur.skills,
      diagnostics: cur.diagnostics,
    }),
  });
  return loader;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/child-loader.test.mts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/child-loader.ts test/child-loader.test.mts
git commit -m "feat(spec-2): CustomResourceLoader builder (noExtensions + composed prompt)"
```

---

## Task 7: Frontmatter — `memoryHydrate` + `vision` fields

**Files:**
- Modify: `src/registry/frontmatter.ts` (add fields to `AgentDef` + `parseAgentFile`)
- Create: `test/frontmatter-spec2.test.mts`

**Interfaces:**
- Produces: `AgentDef.memoryHydrate: boolean` (default `true`), `AgentDef.vision: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

`test/frontmatter-spec2.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile } from "../src/registry/frontmatter.ts";

const FRONT = `---
name: reviewer
description: reviews code
memoryHydrate: false
vision: false
---
body`;
const GLOBAL = `---
name: x
description: y
---
body`;

test("memoryHydrate + vision parse as booleans", () => {
  const a = parseAgentFile(FRONT, "reviewer.md", "project");
  assert.equal(a.memoryHydrate, false);
  assert.equal(a.vision, false);
});

test("memoryHydrate + vision default to true when omitted", () => {
  const a = parseAgentFile(GLOBAL, "x.md", "global");
  assert.equal(a.memoryHydrate, true);
  assert.equal(a.vision, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/frontmatter-spec2.test.mts`
Expected: FAIL — `a.memoryHydrate` undefined

- [ ] **Step 3: Modify `src/registry/frontmatter.ts`**

Add to `AgentDef` (after `todoSync: boolean;`):
```ts
  memoryHydrate: boolean;
  vision: boolean;
```
Add after the `todoSync` line in `parseAgentFile`:
```ts
  const todoSync = raw.todoSync === undefined ? true : Boolean(raw.todoSync);
  const memoryHydrate = raw.memoryHydrate === undefined ? true : Boolean(raw.memoryHydrate);
  const vision = raw.vision === undefined ? true : Boolean(raw.vision);
```
And add `memoryHydrate,` + `vision,` to the returned object literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/frontmatter-spec2.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: PASS — the existing frontmatter tests still pass (new fields default-on, no behavior change for agents that omit them).

- [ ] **Step 6: Commit**

```bash
git add src/registry/frontmatter.ts test/frontmatter-spec2.test.mts
git commit -m "feat(spec-2): frontmatter memoryHydrate + vision fields (bool, default true)"
```

---

## Task 8: `spawnSubagent` — thread ports, `excludeTools`, `customTools`

**Files:**
- Modify: `src/engine/spawnSubagent.ts`
- Modify: `src/engine/spawnSubagent.ts` (`ChildSessionOpts` + `ChildSessionFactory` — add `memoryPort`, `visionPort`)
- Create: `test/spawn-subagent-spec2.test.mts`

**Interfaces:**
- Consumes: `MemoryHydratePort`, `VisionPort`, `createDescribeImageTool` (Task 5), `buildChildLoader` (Task 6).
- Produces: `SpawnOptions` grows `memoryPort: MemoryHydratePort` + `visionPort: VisionPort`; `ChildSessionOpts` grows the same; the child factory uses `excludeTools: ["todo"]` + conditional `customTools`.

- [ ] **Step 1: Write the failing test**

`test/spawn-subagent-spec2.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSubagent } from "../src/engine/spawnSubagent.ts";
import { RunRegistry } from "../src/engine/run-registry.ts";
import { createSingleSlotLock } from "../src/engine/concurrency-lock.ts";

const noopPort = { linkOrCreateRunTodo: async () => ({ todoId: null }), markRunTodoDone: async () => {}, markRunTodoReverted: async () => {} } as any;
const memPort = { renderScopes: () => "## Memory\nblock" } as any;
const visPort = { isMultimodal: () => false, isConfigured: () => true, delegate: async () => ({ ok: true, text: "desc" }) } as any;

test("spawnSubagent threads memoryPort + visionPort to the child factory", async () => {
  let received: any = {};
  const factory = {
    async create(opts: any) {
      received = opts;
      return {
        session: {
          prompt: async () => {},
          subscribe: () => () => {},
          abort: async () => {},
          dispose: () => {},
        },
        model: "ollama/qwen3",
      };
    },
  };
  const reg = new RunRegistry();
  const result = await spawnSubagent({
    agent: "general-purpose",
    task: "do it",
    registry: new Map([["general-purpose", { name: "general-purpose", description: "", rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: true, source: "builtin", filePath: "x" } as any]]),
    todoSync: noopPort, runRegistry: reg, lock: createSingleSlotLock(),
    childFactory: factory, parentModel: { provider: "ollama", id: "qwen3" }, parentCwd: "/proj",
    memoryPort: memPort, visionPort: visPort,
  } as any);
  assert.equal(result.status, "completed");
  assert.equal(received.memoryPort, memPort);
  assert.equal(received.visionPort, visPort);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/spawn-subagent-spec2.test.mts`
Expected: FAIL — `memoryPort` not on `SpawnOptions` / not threaded

- [ ] **Step 3: Modify `src/engine/spawnSubagent.ts`**

In `ChildSessionOpts`, add:
```ts
  memoryPort: MemoryHydratePort;
  visionPort: VisionPort;
```
In `SpawnOptions`, add:
```ts
  memoryPort: MemoryHydratePort;
  visionPort: VisionPort;
```
(Add imports: `import type { MemoryHydratePort } from "../memory-hydrate/port.ts"; import type { VisionPort } from "../vision/port.ts";`)

In `spawnSubagent`, the `opts.childFactory.create({ ... })` call already passes `cwd, model, thinkingLevel, tools, rolePrompt, skills, task`. Add `memoryPort: opts.memoryPort` + `visionPort: opts.visionPort` to that object.

The actual `excludeTools: ["todo"]` + `customTools` wiring happens in `src/index.ts`'s `createChildSessionFactory` (Task 9) — `spawnSubagent` itself stays engine-logic; it just threads the ports through. The tool computation line `const tools = baseTools.filter((t) => !FLEET_OWNED_TOOLS.includes(t));` is **removed** (the `excludeTools` on createAgentSession replaces it). Keep `FLEET_OWNED_TOOLS` as a comment reference or remove it; `PI_DEFAULT_TOOLS` stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/spawn-subagent-spec2.test.mts`
Expected: PASS

- [ ] **Step 5: Run the full spawnSubagent test suite**

Run: `node --import tsx --test test/spawn-subagent.test.mts test/spawn-subagent-spec2.test.mts`
Expected: PASS (existing SPEC-1 tests + new SPEC-2 test; the `todo`-filter removal is covered by updating any SPEC-1 test that asserted the filtered `tools` array — adjust those assertions to expect the unfiltered built-in list since exclusion now happens at createAgentSession).

- [ ] **Step 6: Commit**

```bash
git add src/engine/spawnSubagent.ts test/spawn-subagent-spec2.test.mts
git commit -m "feat(spec-2): thread memoryPort + visionPort through spawnSubagent; drop todo-filter (excludeTools replaces)"
```

---

## Task 9: `index.ts` — wire adapters + build the real child factory with `excludeTools` + `customTools`

**Files:**
- Modify: `src/index.ts`
- Create: `test/index-spec2.test.mts` (smoke that the extension loads + deps are wired)

**Interfaces:**
- Consumes: `ArmoryMemoryAdapter` (Task 3), `ArmoryVisionAdapter` (Task 4), `buildChildLoader` (Task 6), `createDescribeImageTool` (Task 5), `ModelRuntime`.
- Produces: the extension wires `memoryPort` + `visionPort` into `deps`; `createChildSessionFactory` uses `buildChildLoader` + `excludeTools: ["todo"]` + conditional `customTools`.

- [ ] **Step 1: Write the failing test**

`test/index-spec2.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("extension entry exports a default function", async () => {
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.default, "function");
});
```

- [ ] **Step 2: Run test to verify it fails/passes** (it may pass since the default already exists; this is a wiring smoke)

Run: `node --import tsx --test test/index-spec2.test.mts`

- [ ] **Step 3: Modify `src/index.ts`**

Add imports:
```ts
import { ArmoryMemoryAdapter } from "./memory-hydrate/adapter.ts";
import { ArmoryVisionAdapter } from "./vision/adapter.ts";
import { buildChildLoader } from "./engine/child-loader.ts";
import { createDescribeImageTool } from "./vision/describe-image-tool.ts";
import type { MemoryHydratePort } from "./memory-hydrate/port.ts";
import type { VisionPort } from "./vision/port.ts";
```

Replace `createChildSessionFactory`'s loader construction + `createAgentSession` call. The factory signature grows to accept `memoryPort` + `visionPort`:
```ts
function createChildSessionFactory(modelRuntime: ModelRuntime, memoryPort: MemoryHydratePort, visionPort: VisionPort): ChildSessionFactory {
  return {
    async create(opts) {
      let model: Model<any> | undefined;
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        if (slash < 0) throw new Error(`agent model '${opts.model}' must be 'provider/id'`);
        const provider = opts.model.slice(0, slash);
        const id = opts.model.slice(slash + 1);
        model = modelRuntime.getModel(provider, id);
        if (!model) throw new Error(`agent model '${opts.model}' not found in runtime`);
      }
      const loader = buildChildLoader({ cwd: opts.cwd, agent: opts.agent, memoryPort });
      await loader.reload();
      const injectVision = opts.agent.vision && !visionPort.isMultimodal(model);
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        model,
        thinkingLevel: opts.thinkingLevel,
        tools: opts.tools,
        excludeTools: ["todo"],
        customTools: injectVision ? [createDescribeImageTool(visionPort) as never] : [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        modelRuntime,
      });
      return { session: session as unknown as ChildSession, model: opts.model ?? "" };
    },
  };
}
```
The `ChildSessionOpts` passed from `spawnSubagent` now carries `agent` (the full `AgentDef`, so the factory can read `memoryHydrate`/`vision`). Add `agent: AgentDef` to `ChildSessionOpts` and pass `opts.agent` from `spawnSubagent`. Update `spawnSubagent`'s `childFactory.create({ ... })` to include `agent: agentDef`.

In the `deps` object, add:
```ts
    memoryPort: new ArmoryMemoryAdapter(),
    visionPort: new ArmoryVisionAdapter(modelRuntime, deps.parentCwd, getAgentDir()),
```
And pass them to `createChildSessionFactory(modelRuntime, deps.memoryPort, deps.visionPort)`.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: PASS — fix any `ChildSessionOpts`/`ChildSessionFactory` type drift between `spawnSubagent.ts` and `index.ts` (they share the interface; keep them in sync).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-spec2.test.mts
git commit -m "feat(spec-2): wire memory + vision adapters; child factory uses buildChildLoader + excludeTools + conditional describe_image"
```

---

## Task 10: `general-purpose.md` — explicit `memoryHydrate` + `vision`

**Files:**
- Modify: `agents/general-purpose.md`

- [ ] **Step 1: Modify `agents/general-purpose.md`**

```md
---
name: general-purpose
description: A focused general-purpose subagent delegate. Use for any task needing isolated work.
todoSync: true
memoryHydrate: true
vision: true
---
You are a focused subagent delegate. Complete the assigned task thoroughly, work
autonomously to completion, and return a concise result summary. Do not call the
`todo` tool — the fleet engine manages todo tracking for you.
```

- [ ] **Step 2: Verify the builtin parses with the new fields**

Run: `node --import tsx --test test/frontmatter-spec2.test.mts`
Expected: PASS (the builtin's frontmatter now exercises the new fields; add an assertion if desired)

- [ ] **Step 3: Commit**

```bash
git add agents/general-purpose.md
git commit -m "feat(spec-2): general-purpose builtin gets explicit memoryHydrate + vision"
```

---

## Task 11: Panel — armory chip + `i:Info` detail pane

**Files:**
- Modify: `src/panel/rows.ts` (`agentsRow` armory chip + new `agentInfo` fn)
- Modify: `src/panel/fleet-panel.ts` (`i:Info` action + detail pane rendering)
- Create: `test/panel-spec2.test.mts`

**Interfaces:**
- Consumes: `AgentDef.memoryHydrate` + `AgentDef.vision` + `AgentDef.todoSync` (Task 7).
- Produces: `agentsRow` shows `armory:[t✓ m✓ v✓]`; `i:Info` opens a read-only detail pane.

- [ ] **Step 1: Write the failing test**

`test/panel-spec2.test.mts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsRow, agentInfo } from "../src/panel/rows.ts";

const agent = { name: "reviewer", description: "d", model: "anthropic/claude-sonnet-4", tools: ["read","bash"], skills: ["tdd"], rolePrompt: "r", todoSync: true, memoryHydrate: true, vision: false, source: "project" as const, filePath: "x" };

test("agentsRow shows the armory chip", () => {
  const row = agentsRow(agent);
  assert.match(row, /armory:\[t✓ m✓ v✗\]/);
});

test("agentInfo renders all armory hooks + model + skills", () => {
  const info = agentInfo(agent);
  assert.match(info, /todoSync: ✓/);
  assert.match(info, /memoryHydrate: ✓/);
  assert.match(info, /vision: ✗/);
  assert.match(info, /model: anthropic\/claude-sonnet-4/);
  assert.match(info, /skills: tdd/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/panel-spec2.test.mts`
Expected: FAIL — `agentInfo` not exported; `agentsRow` lacks the chip

- [ ] **Step 3: Modify `src/panel/rows.ts`**

Replace the `agentsRow` function:
```ts
export function agentsRow(agent: AgentDef): string {
  const model = agent.model ?? "(default)";
  const chip = `armory:[t${agent.todoSync ? "✓" : "✗"} m${agent.memoryHydrate ? "✓" : "✗"} v${agent.vision ? "✓" : "✗"}]`;
  const skills = agent.skills?.length ? `  skills: ${agent.skills.join(",")}` : "";
  const tools = agent.tools?.length ? `  tools: ${agent.tools.join(",")}` : "";
  return `${agent.name}  [${agent.source}]  ${model}${tools}${skills}  ${chip}`;
}

export function agentInfo(agent: AgentDef): string {
  const lines = [
    `name: ${agent.name}`,
    `source: ${agent.source}`,
    `model: ${agent.model ?? "(default)"}`,
    `thinkingLevel: ${agent.thinkingLevel ?? "(model default)"}`,
    `tools: ${agent.tools?.length ? agent.tools.join(", ") : "(pi default)"}`,
    `skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`,
    `todoSync: ${agent.todoSync ? "✓" : "✗"}`,
    `memoryHydrate: ${agent.memoryHydrate ? "✓" : "✗"}`,
    `vision: ${agent.vision ? "✓" : "✗"}`,
    `file: ${agent.filePath}`,
    "",
    "── role prompt ──",
    agent.rolePrompt.trim(),
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: Modify `src/panel/fleet-panel.ts`** — add an `i:Info` action to the Agents submenu that opens a read-only detail pane rendering `agentInfo(activeAgent)`. Follow the existing panel's input/overlay pattern (the EditorTheme gotcha applies if using `ctx.ui.custom`; for a read-only text dump, use `ctx.ui.notify` or a simple overlay component — match the existing fleet-panel tab/overlay style). Exact rendering code depends on the existing `fleet-panel.ts` structure; the key is wiring the `i` key → `agentInfo(activeAgent)` → display, and returning to the list on Escape.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/panel-spec2.test.mts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/panel/rows.ts src/panel/fleet-panel.ts test/panel-spec2.test.mts
git commit -m "feat(spec-2): Agents-view armory chip + i:Info detail pane"
```

---

## Task 12: Real-pi smoke matrix (`term`-driven)

**Files:**
- Create: `docs/SPEC-2-smoke-checklist.md`
- (No new source — this is the verification gate; mirrors SPEC-1's `docs/SPEC-1-smoke-checklist.md`)

**Prerequisite:** armory-memory + vision companion PRs merged (Tasks 1–2); `pnpm install` re-run so `file:../armory-memory` + `file:../vision` resolve the new `exports`.

- [ ] **Step 1: Write the smoke checklist**

`docs/SPEC-2-smoke-checklist.md`:
```md
# SPEC-2 smoke checklist (real-pi, term-driven)

Run inside real pi via the `term` tool. Each row: set up the agent/model, spawn a
child via the `subagent` tool or `/fleet` Run, capture the child's system prompt +
tools, and assert.

| # | Setup | Assert |
|---|---|---|
| 1 | text-only child model, default agent | describe_image present; system prompt has 3-scope memory block; todo tool absent; no "Open-TODOs" block; no host extension hooks fired |
| 2 | multimodal child model, default agent | describe_image absent (pass-through); memory block present; todo absent |
| 3 | memoryHydrate:false agent | no memory block in child prompt |
| 4 | vision:false agent, text-only model | no describe_image injected |
| 5 | any agent | child prompt contains pi base (tool docs/guidelines/scoped skills) — confirms systemPromptOverride composes, not replaces |

## How to inspect the child's prompt + tools
Spawn the child with a test hook that logs the composed system prompt + active
tool names on session_start, then assert via the `term` capture. (The hook can
be a throwaway project extension in .pi/extensions/ that records to a file the
smoke reads back.)
```

- [ ] **Step 2: Run the smoke via `term`** — spawn real pi, load the armory-fleet extension, open `/fleet`, run a child against a text-only model, capture the child's prompt + tools, assert rows 1–5. The no-cost parts (extension loads, `/fleet` opens, Agents-view shows the armory chip, `i:Info` renders) are verifiable without a model call. Rows 1–5's prompt/tool inspection needs the throwaway logging hook above.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC-2-smoke-checklist.md
git commit -m "docs(spec-2): real-pi smoke checklist (5-row moat + no-leak matrix)"
```

---

## Task 13: CI gate — typecheck + full suite green; release.yml staging

**Files:** none (verification + CI config check)

- [ ] **Step 1: Full local gate**

Run: `cd ~/local-dev/getpipher/armory-fleet && pnpm install && pnpm typecheck && pnpm test:run`
Expected: PASS — all SPEC-1 + SPEC-2 tests green; typecheck clean against the new companion-PR exports.

- [ ] **Step 2: Confirm `release.yml` is staged for the future v0.2.0 tag**

Run: `cat .github/workflows/release.yml | head -20`
Expected: the release workflow exists (staged in SPEC-1); it won't fire until `v0.2.0` tag + the dep switch (RECTOR's co-release).

- [ ] **Step 3: Open the SPEC-2 PR**

```bash
git push -u origin feat/spec-2-deep-armory-integration
gh pr create --title "feat(spec-2): deep armory integration (memory + vision, fleet-owned)" --body "SPEC-2 completes the child-side moat. See specs/SPEC-2-deep-armory-integration.md. Companion PRs: armory-memory (exports), vision (exports + createVisionDelegator). Cursor deferred to SPEC-5b." --base main
```
**Gate:** request review (requesting-code-review skill), address findings, merge to main, delete branch.

---

## Self-Review (run after writing; fix inline)

**Spec coverage:**
- §1 Overview → Tasks 3–9 (the moat) ✓
- §2 Architecture (CustomResourceLoader) → Task 6 ✓
- §3 Components → file structure maps to tasks ✓
- §4 Memory hydration → Tasks 1, 3 ✓
- §5 Vision → Tasks 2, 4, 5 ✓
- §6 Frontmatter → Task 7 ✓
- §7 Spawn lifecycle delta → Tasks 8, 9 ✓
- §8 Agents-view → Task 11 ✓
- §9 Guards (hardened todo-exclusion) → Tasks 8, 9 (`excludeTools`) ✓
- §10 Error handling → Task 4 (not-configured), Task 9 (noExtensions) ✓
- §11 Testing → unit tests in each task + Task 12 smoke ✓
- §12 Deferred (cursor) → not implemented (correct) ✓
- §13 Done bar → Tasks 1–12 ✓

**Placeholder scan:** The two `verify against source` steps (Task 2 Step 1 ModelRegistry mapping; Task 5 Step 3 ToolDefinition execute shape) are impl-verification steps with exact files to check — not vague TODOs. Acceptable.

**Type consistency:** `MemoryHydratePort.renderScopes(scopes)` used identically in Tasks 3, 6, 9 ✓. `VisionPort.{isMultimodal,delegate,isConfigured}` used identically in Tasks 4, 5, 8, 9 ✓. `AgentDef.memoryHydrate`/`vision` added in Task 7, read in Tasks 6, 9, 11 ✓. `USER_PSEUDO_CWD` defined Task 6, used Task 6 ✓.

---

## Execution Handoff

Plan complete and saved to `plans/SPEC-2-deep-armory-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**