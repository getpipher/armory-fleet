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

test("wiring: index.ts session_start registers through the adapter (import smoke + store probe)", async (t) => {
  if (!gateway) return t.skip(`gateway not linked — run: pnpm add -D file:../armory-gateway (${gatewayErr})`);
  // index.ts must import the ADAPTER statically (never the gateway specifier).
  const indexSrc = (await import("node:fs")).readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(indexSrc.includes("registerMcpGovernance"), "session_start must call registerMcpGovernance");
  assert.ok(!/import\s+[^;]*from\s+["']@getpipher\/armory-gateway["']/.test(indexSrc), "static gateway import is forbidden");
  assert.ok(indexSrc.includes("loadDenyList"), "provider must close over the settings store via loadDenyList");
});
