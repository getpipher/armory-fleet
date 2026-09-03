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
  // Exact tool match wins over a bare server entry regardless of deny-list order.
  const entry = deny.find((candidate) => candidate === composed) ?? deny.find((candidate) => candidate === target.server);
  if (entry === undefined) return { decision: "allow" };
  return { decision: "deny", reason: `denied by armory-fleet mcpDeny policy: matched "${entry}"` };
}
