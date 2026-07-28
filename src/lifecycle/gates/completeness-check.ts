import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GateDef, GateCtx, GateResult } from "./registry.ts";

export interface CompletenessResult { passed: boolean; evidence: string; }

/** Pure-ish: stat every claimed path. Relative paths resolve against baseDir. */
export function checkCompleteness(paths: string[], baseDir: string): CompletenessResult {
  if (paths.length === 0) return { passed: true, evidence: "no claimed artifacts (terminal-phase exemption)" };
  const missing: string[] = [];
  let found = 0;
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(baseDir, p);
    try {
      statSync(abs);
      found++;
    } catch {
      missing.push(p);
    }
  }
  if (missing.length > 0) {
    return { passed: false, evidence: `missing: ${missing.join(", ")} (${found}/${paths.length} exist)` };
  }
  return { passed: true, evidence: `${paths.length}/${paths.length} artifacts exist` };
}

export const completenessCheckGate: GateDef = {
  name: "completenessCheck",
  kind: "predicate",
  onFail: "revise",
  run: async (ctx: GateCtx): Promise<GateResult> => {
    const base = ctx.worktreePath ?? process.cwd();
    const r = checkCompleteness(ctx.phaseRec.paths, base);
    return { gate: "completenessCheck", kind: "predicate", passed: r.passed, evidence: r.evidence, onFail: "revise" };
  },
};