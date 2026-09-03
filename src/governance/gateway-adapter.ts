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
