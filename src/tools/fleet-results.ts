// src/tools/fleet-results.ts
// SPEC-5a §10/§12.2 — the agent pulls completed bg-run results from the inbox (Q6=C).
import { Type, type Static } from "typebox";
import type { ResultsInbox } from "../runtime/results-inbox.ts";

export const fleetResultsParams = Type.Object({
  runId: Type.Optional(Type.String({ description: "Pull a specific run's result. Omit to pull all ready (undelivered) results." })),
});

export type FleetResultsInput = Static<typeof fleetResultsParams>;

export interface FleetResultsToolDeps {
  inbox: ResultsInbox;
}

export function createFleetResultsTool(deps: FleetResultsToolDeps) {
  return {
    name: "fleet_results",
    label: "Fleet results",
    description: "Pull completed background fleet-run results from the inbox. With a runId, returns that run's result. Without, returns all ready (undelivered) results. Pulling marks them delivered. The durable record also lives in the lifecycle TODO notes + the /fleet panel.",
    promptSnippet: "Pull completed background fleet-run results",
    promptGuidelines: [
      "Use fleet_results to pull completed background runs when the 'N fleet results ready' hint appears.",
      "Without a runId, returns all ready results and marks them delivered.",
    ],
    parameters: fleetResultsParams,
    async execute(_toolCallId: string, input: FleetResultsInput) {
      const results = deps.inbox.pull(input.runId);
      return {
        content: [{ type: "text" as const, text: results.length === 0 ? "no results ready" : results.map((r) => `${r.runId}: ${r.status} — ${r.summary}`).join("\n") }],
        details: { results },
      };
    },
  };
}