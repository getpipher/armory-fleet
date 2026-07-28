import type { GateDef, GateCtx, GateResult } from "./registry.ts";

export interface GateChainOutcome {
  results: GateResult[];
  shortCircuit?: { action: "revise" | "abort"; feedback?: string; reason?: string };
}

/** Run the gate chain left-to-right. Advise-failures continue; revise/abort short-circuit. */
export async function runGateChain(opts: { gates: GateDef[]; ctx: GateCtx }): Promise<GateChainOutcome> {
  const results: GateResult[] = [];
  for (const gate of opts.gates) {
    // Each gate sees its own params on ctx.gateParams (set per-gate by the caller/run-lifecycle).
    const gateCtx: GateCtx = { ...opts.ctx, gateParams: gate.params };
    const started = Date.now();
    let result: GateResult;
    try {
      result = await gate.run(gateCtx);
    } catch (e) {
      // A throwing gate is treated as an advise-failure (never auto-revise on a crash).
      result = { gate: gate.name, kind: gate.kind, passed: false, evidence: `gate '${gate.name}' threw: ${(e as Error).message}`, onFail: gate.onFail };
    }
    result.durationMs = Date.now() - started;
    results.push(result);
    if (!result.passed) {
      if (gate.onFail === "revise") {
        return { results, shortCircuit: { action: "revise", feedback: result.evidence } };
      }
      if (gate.onFail === "abort") {
        return { results, shortCircuit: { action: "abort", reason: result.evidence } };
      }
      // advise → continue
    }
  }
  return { results };
}