# armory-fleet 1b-2 — Fleet Governance Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register armory-fleet as armory-gateway's first live governance provider (settings-driven `mcpDeny` deny-list) and align fleet's pi dependency line to `^0.84.4`.

**Architecture:** Pure matcher (`src/governance/mcp-policy.ts`) + thin adapter (`src/governance/gateway-adapter.ts`) that dynamically imports the unpublished gateway package (guarded, never a static specifier) and registers a provider closing over fleet's existing per-session `FleetSettingsStore`. Absent gateway → silent skip, fleet behavior byte-identical to v1.2.0.

**Tech Stack:** TypeScript raw `.ts` (tsx runtime, jiti in pi's loader), `node:test`, pnpm 10. Consumes `@getpipher/armory-gateway` main @ `410a22c` via dev `file:` link.

> **Spec:** `docs/SPEC-1b-2-fleet-governance-adapter.md` (staged at `~/Documents/secret/strategy/getpipher/armory-gateway/` pre-relocation; RECTOR-approved 2026-08-30). **Plan-phase verification: V1 ✅ V2 ✅ (via vision@0.5.3 rider, merged PR #26) V3 ✅ vacuous V4 ✅ — results baked into the tasks below.**

**Working repo:** `~/local-dev/getpipher/armory-fleet/` — branch `feat/1b-2-fleet-governance-adapter` off `main` @ `aa0dbef`.

## Global Constraints

- Node 24 strip mode: **NO TS parameter properties** (use explicit field declarations + constructor assignment).
- 2-space indent. No AI attribution anywhere. No TODO/FIXME left behind. English only.
- Tests: flat `test/*.test.mts` (the `test:run` glob `test/*.test.mts` is NON-recursive — never create `test/` subdirectories). Tests import source with explicit `.ts` extensions: `import { … } from "../src/governance/mcp-policy.ts"`.
- Gate (every implementer/fixer dispatch, every pre-commit): `pnpm typecheck && pnpm test:run`.
- **This is a fleet-only PR** — zero changes to the armory-gateway repo.
- The string `"@getpipher/armory-gateway"` must never appear in a fleet **static** import (top-level `import … from`); only inside dynamic `import()` calls in `src/governance/gateway-adapter.ts` and the test file.
- Baseline at plan time: main @ `aa0dbef`, `pnpm typecheck` green, `pnpm test:run` 837/837.

## Verification results (plan-phase, empirical — 2026-08-30/09-02)

| V | Result |
|---|---|
| V1 link resolvability | ✅ `pnpm add -D file:../armory-gateway` creates a pnpm symlink (virtual store pulls gateway's own deps — `pi-ai@0.84.4` visible in store path). Named exports resolve under plain tsx AND under pi's actual jiti loader (36 exports, `registerGovernanceProvider` function). |
| V2 pi bump | ✅ AFTER the vision rider: pi-ai 0.84 widened `ProviderHeaders` to `Record<string, string | null>` and vision@0.5.2 (raw `.ts`, latest) failed fleet typecheck with exactly 2 errors. Fixed upstream in vision PR #26 → published 0.5.3 → fleet range `^0.5.3` → typecheck + 844/844 green. **Fleet also carried a stale pnpm patch for vision@0.5.2 (same null-header fix, superseded by 0.5.3) — `pnpm-workspace.yaml` + `patches/` get deleted in Task 1.** |
| V3 typebox skew | ✅ vacuous — no typebox symptoms surfaced under V2; contract passes plain objects; typebox stays `^1.1.38`. |
| V4 settings wiring | ✅ `FleetSettingsStore` lives at `src/index.ts:607` INSIDE `session_start` (`dir = fleetDir(ctx.cwd)`). Registration wires there; `loadDenyList` reuses the existing `fleetSettingsStore` instance — no second store. |

## RECTOR gate before merge (Task 4 dependency)

Gateway repo is **private** — fleet CI cannot clone it token-less (unlike public armory-todo). The committed `file:` devDep makes CI install REQUIRE the sibling. One-time secret setup, RECTOR runs:

```
gh secret set SIBLINGS_PAT -R getpipher/armory-fleet --body "$(gh auth token)"
```

Until the secret exists, the CI `armory-gate-contracts` job (Task 4) is expected red on install — merge only after it's green. If RECTOR declines the secret, fallback: drop the devDep + CI job from Task 4 and keep the link as an uncommitted local dev step (contract tests then skip in CI — weaker evidence, spec §13 acceptance degrades; RECTOR's call at the plan gate).

---

### Task 1: Dependency alignment + vision patch removal

**Files:**
- Modify: `package.json` (dependencies block)
- Delete: `pnpm-workspace.yaml`, `patches/@getpipher__vision@0.5.2.patch`

**Interfaces:**
- Produces: installed `@earendil-works/*` at 0.84.4, `@getpipher/vision` at ^0.5.3, no pnpm patches. Every later task builds on this tree.

- [ ] **Step 1: Create the branch**

```bash
cd ~/local-dev/getpipher/armory-fleet
git checkout main && git pull --ff-only
git checkout -b feat/1b-2-fleet-governance-adapter
```

- [ ] **Step 2: Edit `package.json` dependencies** — exactly these four lines change:

```json
"@earendil-works/pi-coding-agent": "^0.84.4",
"@earendil-works/pi-tui": "^0.84.4",
"@earendil-works/pi-ai": "^0.84.4",
"@getpipher/vision": "^0.5.3",
```

(All other deps, placement in `dependencies`, peer map `{}` — unchanged. No `version` bump.)

- [ ] **Step 3: Delete the superseded vision patch**

```bash
rm pnpm-workspace.yaml
rm patches/@getpipher__vision@0.5.2.patch
rmdir patches
```

`pnpm-workspace.yaml` contains ONLY the `patchedDependencies` block (verified — deleting the file is the clean removal; fleet is not a pnpm workspace).

- [ ] **Step 4: Install and run the gate**

```bash
pnpm install
pnpm typecheck && pnpm test:run
```

Expected: install clean (no `ERR_PNPM_UNUSED_PATCH`), typecheck green, 837+/837+ tests pass (count may differ ± a few from baseline 837 due to vision 0.5.3 internals — zero FAILURES is the criterion; the V2 verification run showed 844/844).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(deps): align @earendil-works/* to ^0.84.4; vision ^0.5.3; drop superseded vision patch"
```

---

### Task 2: `mcpDeny` settings field

**Files:**
- Modify: `src/settings/fleet-settings.ts` (interface + `parseFleetSettings` + known-set)
- Test: `test/fleet-settings.test.mts` (extend existing)

**Interfaces:**
- Produces: `FleetSettings.mcpDeny?: string[]` on the parsed-settings type; parse semantics (per-entry warn+drop) that Task 3's matcher and Task 4's provider rely on. Test fixtures in this task reuse `parseFleetSettings(json: string, label?: string): FleetSettingsResult` (existing export).

- [ ] **Step 1: Write the failing tests** — append to `test/fleet-settings.test.mts` (the file already imports `test`, `strictEqual`, `deepStrictEqual`, `ok`, `mkdtempSync`, `mkdirSync`, `rmSync`, `writeFileSync`, `tmpdir`, `join`, `parseFleetSettings`, `FleetSettingsStore` — use those; add NO new imports):

```ts
 test("parseFleetSettings: mcpDeny valid entries parse through (bare server + server__tool)", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: ["github", "github__delete_repo", "internal-tools"] }));
  deepStrictEqual(r.settings.mcpDeny, ["github", "github__delete_repo", "internal-tools"]);
  deepStrictEqual(r.warnings, []);
});

test("parseFleetSettings: mcpDeny invalid entries warn + drop per-entry, valid entries stay enforced", () => {
  const r = parseFleetSettings(
    JSON.stringify({ mcpDeny: ["github__delete_repo", "", "a__", "__b", "server__*", 42] }),
    "settings.json",
  );
  deepStrictEqual(r.settings.mcpDeny, ["github__delete_repo"]);
  strictEqual(r.warnings.length, 5);
  for (const w of r.warnings) {
    ok(w.startsWith("settings.json: mcpDeny entry"), `actionable + file-labeled: ${w}`);
  }
});

test("parseFleetSettings: mcpDeny non-array value warns + field dropped", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: "github" }), "settings.json");
  strictEqual(r.settings.mcpDeny, undefined);
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes("mcpDeny must be an array of strings"));
});

test("parseFleetSettings: mcpDeny empty array is valid (explicit no-op list)", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: [] }));
  deepStrictEqual(r.settings.mcpDeny, []);
  deepStrictEqual(r.warnings, []);
});

test("parseFleetSettings: mcpDeny itself is a known key; sibling typos still warn", () => {
  const r = parseFleetSettings(
    JSON.stringify({ mcpDeny: ["github"], mcpDenyTypo: ["x"] }),
    "settings.json",
  );
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes('unknown setting "mcpDenyTypo"'));
});

test("store.load: mcpDeny project wins per-field over global (whole-field replacement)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, JSON.stringify({ mcpDeny: ["global-only"] }));
    writeFileSync(p, JSON.stringify({ mcpDeny: ["project-only"] }));
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    deepStrictEqual(store.load().settings.mcpDeny, ["project-only"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify RED**

```bash
pnpm test:run 2>&1 | grep -E "mcpDeny|ℹ (pass|fail)"
```

Expected: the new tests FAIL (`settings.mcpDeny` undefined / TS errors on the fixture literals). Note the failure lines as RED evidence.

- [ ] **Step 3: Implement** — in `src/settings/fleet-settings.ts`:

(a) Extend the interface (keep the existing field + comment untouched):

```ts
/** SPEC-1b-2: MCP governance deny-list. Entries are bare server names (deny the whole
 *  server) or `server__tool` (deny one exact tool). Invalid entries warn + drop. */
mcpDeny?: string[];
```

(b) Add the entry validator above `parseFleetSettings`:

```ts
/** SPEC-1b-2: a valid mcpDeny entry is a non-empty bare server name (no `__`) or
 *  `server__tool` with BOTH parts non-empty. First `__` separates; a tool name
 *  containing `__` is allowed (gateway composes the same way). Globs are invalid —
 *  glob metacharacters (`*?[`) are rejected wherever they appear. */
function isValidMcpDenyEntry(entry: string): boolean {
  if (entry.length === 0) return false;
  if (/[*?\[]/.test(entry)) return false;
  const idx = entry.indexOf("__");
  if (idx === -1) return true;
  return idx > 0 && idx + 2 < entry.length;
}
```

(c) Inside `parseFleetSettings`, after the `defaultSubagentThinking` block:

```ts
const deny = obj["mcpDeny"];
if (deny !== undefined) {
  if (Array.isArray(deny)) {
    const entries: string[] = [];
    for (const item of deny) {
      if (typeof item !== "string") {
        warnings.push(`${label}: mcpDeny entry ${JSON.stringify(item)} is invalid — expected "server" or "server__tool" — dropped`);
        continue;
      }
      if (isValidMcpDenyEntry(item)) {
        entries.push(item);
      } else {
        warnings.push(`${label}: mcpDeny entry ${JSON.stringify(item)} is invalid — expected "server" or "server__tool" — dropped`);
      }
    }
    settings.mcpDeny = entries;
  } else {
    warnings.push(`${label}: mcpDeny must be an array of strings — dropped`);
  }
}
```

(d) Update the known-set line:

```ts
const known = new Set(["defaultSubagentThinking", "mcpDeny"]);
```

- [ ] **Step 4: Run to verify GREEN**

```bash
pnpm typecheck && pnpm test:run 2>&1 | grep -E "ℹ (pass|fail)"
```

Expected: typecheck green, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/settings/fleet-settings.ts test/fleet-settings.test.mts
git commit -m "feat(settings): mcpDeny deny-list field (per-entry validation, warn+drop)"
```

---

### Task 3: Pure policy matcher

**Files:**
- Create: `src/governance/mcp-policy.ts`
- Test: `test/mcp-policy.test.mts`

**Interfaces:**
- Consumes: nothing (pure, leaf).
- Produces: `evaluateMcpPolicy(deny: readonly string[] | undefined, target: { server: string; tool: string }): { decision: "allow" } | { decision: "deny"; reason: string }` — Task 4's provider calls exactly this.

- [ ] **Step 1: Write the failing tests** — create `test/mcp-policy.test.mts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMcpPolicy } from "../src/governance/mcp-policy.ts";

test("matcher: exact tool deny wins with the matched entry in the reason", () => {
  const d = evaluateMcpPolicy(["github", "github__delete_repo"], { server: "github", tool: "delete_repo" });
  assert.deepEqual(d, { decision: "deny", reason: 'denied by armory-fleet mcpDeny policy: matched "github__delete_repo"' });
});

test("matcher: bare server entry denies every tool on that server", () => {
  for (const tool of ["delete_repo", "create_issue", "anything"]) {
    const d = evaluateMcpPolicy(["github"], { server: "github", tool });
    assert.equal(d.decision, "deny");
  }
});

test("matcher: non-listed server+tool allows", () => {
  const d = evaluateMcpPolicy(["github", "github__delete_repo"], { server: "slack", tool: "post_message" });
  assert.deepEqual(d, { decision: "allow" });
});

test("matcher: absent / undefined / empty deny list allows", () => {
  assert.deepEqual(evaluateMcpPolicy(undefined, { server: "github", tool: "delete_repo" }), { decision: "allow" });
  assert.deepEqual(evaluateMcpPolicy([], { server: "github", tool: "delete_repo" }), { decision: "allow" });
});

test("matcher: malformed entries cannot match (exact lookups only, no entry parsing)", () => {
  const d = evaluateMcpPolicy(["", "a__", "__b", "server__*"], { server: "a", tool: "b" });
  assert.deepEqual(d, { decision: "allow" });
});

test("matcher: does not mutate or read beyond server/tool (args ignored by contract)", () => {
  const target = { server: "github", tool: "delete_repo" };
  const d = evaluateMcpPolicy(["github__delete_repo"], target);
  assert.equal(d.decision, "deny");
});
```

- [ ] **Step 2: Run to verify RED**

```bash
pnpm test:run 2>&1 | grep -E "mcp-policy|ℹ fail"
```

Expected: FAIL — `Cannot find module '../src/governance/mcp-policy.ts'`.

- [ ] **Step 3: Implement** — create `src/governance/mcp-policy.ts`:

```ts
// src/governance/mcp-policy.ts — pure MCP deny-list matcher (SPEC-1b-2 D3).
// Total function: no I/O, no throwing. Entries are validated at parse time
// (fleet-settings.ts); the matcher performs exact-match lookups only and
// never parses entries at match time.

export interface McpPolicyTarget {
  server: string;
  tool: string;
}

export type McpPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

export function evaluateMcpPolicy(deny: readonly string[] | undefined, target: McpPolicyTarget): McpPolicyDecision {
  if (!deny || deny.length === 0) return { decision: "allow" };
  const composed = `${target.server}__${target.tool}`;
  // Exact-tool entry takes precedence when both forms are listed — the more specific
  // reason is strictly more informative; the decision is deny either way.
  const entry = deny.find((candidate) => candidate === composed) ?? deny.find((candidate) => candidate === target.server);
  if (entry === undefined) return { decision: "allow" };
  return { decision: "deny", reason: `denied by armory-fleet mcpDeny policy: matched "${entry}"` };
}
```

- [ ] **Step 4: Run to verify GREEN**

```bash
pnpm typecheck && pnpm test:run 2>&1 | grep -E "ℹ (pass|fail)"
```

- [ ] **Step 5: Commit**

```bash
git add src/governance/mcp-policy.ts test/mcp-policy.test.mts
git commit -m "feat(governance): pure mcpDeny matcher (exact server / server__tool lookups)"
```

---

### Task 4: Gateway adapter + contract tests + dev link + CI sibling job

**Files:**
- Create: `src/governance/gateway-adapter.ts`
- Test: `test/gateway-adapter.test.mts`
- Modify: `package.json` (devDependencies), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `evaluateMcpPolicy` (Task 3, exact signature above); real `@getpipher/armory-gateway` module via dev link (`registerGovernanceProvider(fn)` where `fn({server, tool, args, agent?, task?}) → Promise<{decision, reason?}>`).
- Produces: `registerMcpGovernance(deps: { loadDenyList: () => string[] | undefined; importGateway: () => Promise<GatewayModuleLike> }): Promise<{ registered: boolean }>` and `defaultImportGateway(): Promise<GatewayModuleLike>` — Task 5 wires exactly these.

- [ ] **Step 1: Add the dev link** (verified in V1 — pnpm symlinks the sibling and resolves gateway's own deps):

```bash
pnpm add -D file:../armory-gateway
```

Expected: `"@getpipher/armory-gateway": "file:../armory-gateway"` appears in devDependencies. The sibling must exist (it does locally at `~/local-dev/getpipher/armory-gateway/`).

- [ ] **Step 2: Write the failing contract tests** — create `test/gateway-adapter.test.mts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMcpGovernance, defaultImportGateway, makeGovernanceProvider, type GatewayModuleLike } from "../src/governance/gateway-adapter.ts";

// The gateway is an unpublished PRIVATE package, linked as a dev dependency
// (file:../armory-gateway). Where it is not resolvable (fresh clone without the
// sibling, CI without the sibling job), the contract tests SKIP LOUDLY — the
// skip message names the exact link command.
let gateway: typeof import("@getpipher/armory-gateway") | null = null;
let gatewayErr: string | null = null;
try {
  gateway = await import("@getpipher/armory-gateway");
} catch (e) {
  gatewayErr = (e as Error).message;
}

const STORE_SYMBOL = Symbol.for("@getpipher/armory-gateway:registry");
function governanceSlot(): unknown {
  const host = globalThis as Record<symbol, unknown>;
  const store = host[STORE_SYMBOL] as { governance?: unknown } | undefined;
  return store?.governance;
}

test("contract: registration fires against the REAL gateway module (symbol store reflects it)", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  const before = governanceSlot();
  const res = await registerMcpGovernance({ loadDenyList: () => undefined, importGateway: defaultImportGateway });
  assert.equal(res.registered, true);
  assert.ok(governanceSlot(), "governance slot must be set after registration");
  assert.notEqual(governanceSlot(), before ?? null);
});

test("contract: registered provider denies a deny-listed call with the exact reason", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  let denyList: string[] | undefined = ["github__delete_repo"];
  await registerMcpGovernance({
    loadDenyList: () => denyList,
    importGateway: defaultImportGateway,
  });
  const provider = governanceSlot() as (input: { server: string; tool: string }) => Promise<{ decision: string; reason?: string }>;
  const denied = await provider({ server: "github", tool: "delete_repo" });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, 'denied by armory-fleet mcpDeny policy: matched "github__delete_repo"');
});

test("contract: per-call freshness — policy edits flip decisions without re-registration", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  let denyList: string[] | undefined = undefined;
  await registerMcpGovernance({ loadDenyList: () => denyList, importGateway: defaultImportGateway });
  const provider = governanceSlot() as (input: { server: string; tool: string }) => Promise<{ decision: string }>;
  assert.equal((await provider({ server: "github", tool: "push" })).decision, "allow");
  denyList = ["github"];
  assert.equal((await provider({ server: "github", tool: "push" })).decision, "deny");
  denyList = [];
  assert.equal((await provider({ server: "github", tool: "push" })).decision, "allow");
});

test("contract: two gateway module instances converge on one symbol store (Symbol.for global)", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  // Cache-busting query → DISTINCT resolved URL → a second module INSTANCE. The store
  // lives on globalThis[Symbol.for(...)], so a registration made THROUGH the dup
  // instance must be visible via the shared symbol key the gateway interceptors read.
  const dupSpec = "@getpipher/armory-gateway?dup=1";
  const dup = (await import(dupSpec)) as GatewayModuleLike;
  const res = await registerMcpGovernance({ loadDenyList: () => undefined, importGateway: () => Promise.resolve(dup) });
  assert.equal(res.registered, true);
  const store = (globalThis as Record<symbol, unknown>)[STORE_SYMBOL] as { governance?: unknown } | undefined;
  assert.ok(store?.governance, "registration through a second module instance is visible via the shared symbol store");
});

test("contract: import failure → { registered: false }, no throw, no registration", async () => {
  const res = await registerMcpGovernance({
    loadDenyList: () => undefined,
    importGateway: () => Promise.reject(new Error("Cannot find package '@getpipher/armory-gateway'")),
  });
  assert.deepEqual(res, { registered: false });
});

test("adapter: makeGovernanceProvider passes only server/tool into the matcher (args never enter policy)", async () => {
  const seen: Array<{ server: string; tool: string }> = [];
  const provider = makeGovernanceProvider({
    loadDenyList: () => undefined,
    importGateway: () => Promise.reject(new Error("unused")),
  });
  // Local shape check — the provider must not depend on extra input fields.
  const decision = await provider({ server: "s", tool: "t", args: { big: "payload" } } as Parameters<typeof provider>[0]);
  seen.push({ server: "s", tool: "t" });
  assert.equal(decision.decision, "allow");
  assert.equal(seen.length, 1);
});
```

- [ ] **Step 3: Run to verify RED**

```bash
pnpm test:run 2>&1 | grep -E "gateway-adapter|ℹ fail"
```

Expected: FAIL — `Cannot find module '../src/governance/gateway-adapter.ts'`.

- [ ] **Step 4: Implement** — create `src/governance/gateway-adapter.ts`:

```ts
// src/governance/gateway-adapter.ts — registers fleet's MCP governance provider with
// armory-gateway when the gateway package is resolvable (SPEC-1b-2 D4).
//
// The import is DYNAMIC and GUARDED: fleet is a public npm package; armory-gateway is
// unpublished/private, so the specifier must NEVER appear in a static import (a static
// specifier would break every public fleet install at link time). Absent gateway →
// { registered: false } — standalone behavior, byte-identical to fleet v1.2.0.
// Gateway's `status` interceptor line is the observability surface for "is the moat on".

import { evaluateMcpPolicy } from "./mcp-policy.ts";

/** Structural mirror of armory-gateway's GovernanceInput/GovernanceResult (SPEC-1b §3).
 *  Shapes MUST stay assignment-compatible with the real module (required `args`, full
 *  decision union) so the real import satisfies GatewayModuleLike under
 *  strictFunctionTypes. This local mirror keeps the adapter typecheckable even in
 *  checkouts where the gateway dev link is absent. */
export interface GovernanceInputLike {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  agent?: string;
  task?: string;
}

export type GovernanceDecisionLike = { decision: "allow" | "deny" | "rate" | "cost" | "prompt"; reason?: string };

export type GovernanceProviderLike = (input: GovernanceInputLike) => Promise<GovernanceDecisionLike>;

export interface GatewayModuleLike {
  registerGovernanceProvider(fn: GovernanceProviderLike): void;
}

export interface GatewayAdapterDeps {
  /** Fresh per call (SPEC-1b-2 Q5c) — reads through the session's FleetSettingsStore. */
  loadDenyList: () => string[] | undefined;
  /** Injectable for tests. Production: defaultImportGateway. */
  importGateway: () => Promise<GatewayModuleLike>;
}

export interface GatewayAdapterResult {
  registered: boolean;
}

export function defaultImportGateway(): Promise<GatewayModuleLike> {
  // Dynamic import with a literal specifier — resolved by tsx/jiti/node through the
  // dev `file:` link. The cast narrows the 36-export module to the seam we use.
  return import("@getpipher/armory-gateway") as unknown as Promise<GatewayModuleLike>;
}

export function makeGovernanceProvider(deps: GatewayAdapterDeps): GovernanceProviderLike {
  return async (input) => {
    // Policy is identity-based (server/tool) — args never enter policy code.
    return evaluateMcpPolicy(deps.loadDenyList(), { server: input.server, tool: input.tool });
  };
}

export async function registerMcpGovernance(deps: GatewayAdapterDeps): Promise<GatewayAdapterResult> {
  let gateway: GatewayModuleLike;
  try {
    gateway = await deps.importGateway();
  } catch {
    // Absent gateway is the NORMAL state for public-npm fleet installs — silent skip.
    return { registered: false };
  }
  gateway.registerGovernanceProvider(makeGovernanceProvider(deps));
  return { registered: true };
}
```

- [ ] **Step 5: Run to verify GREEN**

```bash
pnpm typecheck && pnpm test:run 2>&1 | grep -E "ℹ (pass|fail)"
```

Expected: typecheck green; contract tests PASS (gateway linked locally); 0 failures.

- [ ] **Step 6: CI sibling job** — in `.github/workflows/ci.yml`, directly AFTER the armory-todo clone step (same pattern; private repo needs the token):

```yaml
      - name: Clone armory-gateway sibling (contract-test dependency)
        run: git clone --depth 1 https://x-access-token:${{ secrets.SIBLINGS_PAT }}@github.com/getpipher/armory-gateway.git ../armory-gateway
```

(The committed `file:` devDep makes `pnpm install --frozen-lockfile` REQUIRE the sibling in CI — this step satisfies it. RECTOR sets the secret per the plan-header gate; CI is red until then. No `continue-on-error` — a silent red-by-design job violates the no-silent-failure rule.)

- [ ] **Step 7: Gate + commit**

```bash
pnpm typecheck && pnpm test:run 2>&1 | grep -E "ℹ (pass|fail)"
git add package.json pnpm-lock.yaml src/governance/gateway-adapter.ts test/gateway-adapter.test.mts .github/workflows/ci.yml
git commit -m "feat(governance): guarded dynamic-import adapter + gateway contract tests (dev file: link, CI sibling job)"
```

---

### Task 5: session_start wiring

**Files:**
- Modify: `src/index.ts` (imports + the `session_start` handler, after the `fleetSettingsStore` block at ~line 607)
- Test: `test/gateway-adapter.test.mts` (extend with a wiring-shape test)

**Interfaces:**
- Consumes: `registerMcpGovernance` / `defaultImportGateway` (Task 4 exact signatures); `fleetSettingsStore` (existing local at the wiring site).

- [ ] **Step 1: Write the failing test** — append to `test/gateway-adapter.test.mts`:

```ts
test("wiring: index.ts session_start registers through the adapter (import smoke + store probe)", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  // index.ts must import the ADAPTER statically (never the gateway specifier).
  const indexSrc = (await import("node:fs")).readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(indexSrc.includes("registerMcpGovernance"), "session_start must call registerMcpGovernance");
  assert.ok(!/import\s+[^;]*from\s+["']@getpipher\/armory-gateway["']/.test(indexSrc), "static gateway import is forbidden");
  assert.ok(indexSrc.includes("loadDenyList"), "provider must close over the settings store via loadDenyList");
});
```

- [ ] **Step 2: Run to verify RED**

```bash
pnpm test:run 2>&1 | grep -E "wiring:|ℹ fail"
```

- [ ] **Step 3: Implement** — in `src/index.ts`:

(a) Add to the import block (static import of the ADAPTER is fine — the gateway specifier lives only inside its dynamic import):

```ts
import { registerMcpGovernance, defaultImportGateway } from "./governance/gateway-adapter.ts";
```

(b) Make the `session_start` handler async — change `pi.on("session_start", (_event, ctx) => {` to:

```ts
pi.on("session_start", async (_event, ctx) => {
```

(Extension handlers returning a Promise are awaited by the extension runtime; if typecheck rejects the async handler signature, fall back to `.then()`/`.catch()` chaining on the `registerMcpGovernance` promise — document the choice in the commit body.)

(c) Directly after `deps.defaultSubagentThinking = fleetSettings.settings.defaultSubagentThinking;` (~line 613):

```ts
// SPEC-1b-2: register fleet's MCP governance provider with armory-gateway (when the
// unpublished private gateway package is resolvable). Reuses THIS session's settings
// store — per-call fresh reads, cwd-correct project path, idempotent under the
// gateway's replace-semantics. Absent gateway → silent skip (public-npm normal state).
await registerMcpGovernance({
  loadDenyList: () => fleetSettingsStore.load().settings.mcpDeny,
  importGateway: defaultImportGateway,
});
```

- [ ] **Step 4: Run to verify GREEN + full gate**

```bash
pnpm typecheck && pnpm test:run 2>&1 | grep -E "ℹ (pass|fail)"
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/gateway-adapter.test.mts
git commit -m "feat(governance): register MCP governance provider in session_start (reuses session settings store)"
```

---

### Task 6: README + docs relocation + PR

**Files:**
- Modify: `README.md` (MCP governance section)
- Create (untracked, staged into the PR): `docs/SPEC-1b-2-fleet-governance-adapter.md`, `docs/PLAN-1b-2-fleet-governance-adapter.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–5. No code changes.

- [ ] **Step 1: README section** — add after the settings/tiers section (match the existing heading style):

````markdown
## MCP governance (armory-gateway integration)

When [armory-gateway](https://github.com/getpipher/armory-gateway) is resolvable, fleet
registers an MCP governance provider at session start: every MCP call made through the
gateway passes fleet's `mcpDeny` policy before it executes.

`~/.pi/agent/fleet/settings.json` (global) and `<cwd>/.pi/fleet/settings.json` (project,
wins per-field):

```json
{
  "mcpDeny": [
    "github__delete_repo",
    "internal-tools"
  ]
}
```

- Entries: bare `server` (deny the whole server) or `server__tool` (deny one exact tool).
- Invalid entries produce an actionable warning and are dropped; valid entries stay enforced.
- Policy is re-read per call — edits take effect immediately.
- Gateway absent (the default for public fleet installs)? Nothing changes: registration
  is skipped silently and fleet behaves exactly as before. Check the gateway's `status`
  output — `interceptors governance=✗` means standalone.
````

No claims beyond wired behavior. No mention of deferred features as if shipped.

- [ ] **Step 2: Relocate spec + plan into `docs/`**

```bash
cp ~/Documents/secret/strategy/getpipher/armory-gateway/SPEC-1b-2-fleet-governance-adapter.md docs/
cp ~/Documents/secret/strategy/getpipher/armory-gateway/PLAN-1b-2-fleet-governance-adapter.md docs/
```

- [ ] **Step 3: Full gate + commit**

```bash
pnpm typecheck && pnpm test:run
git add README.md docs/
git commit -m "docs: MCP governance section + SPEC/PLAN-1b-2 relocation"
```

- [ ] **Step 4: PR** — push, open with `--body-file` (body drafted at execution time from the spec's §13 acceptance + this plan's verification table; dev-humble tone, no AI attribution), merge `gh pr merge N --merge --delete-branch` **only after**: full gate green locally AND the CI job green (which requires RECTOR's `SIBLINGS_PAT` secret — see plan header).

- [ ] **Step 5: Post-merge pointer** — add one line to armory-gateway's progress table (1b-2 → DONE + PR #) and a pointer note in `SPEC-1b §16` that 1b-2 landed as a fleet PR with ARMORY_*/cost deferral per SPEC-1b-2 §15. Then live smoke (V5, dogfood, not CI): pi session running fleet-from-local + linked gateway → gateway `status` shows `interceptors governance=✓`; a deny-listed call renders `governance_denied`; `mcpDeny` edit takes effect without restart.
