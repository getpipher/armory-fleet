import type { GateDef, GateCtx, GateResult } from "./registry.ts";

/** Default patterns: a verification command invocation AND a result signal.
 *  A command alone (no result) is a claim, not evidence. */
const DEFAULT_COMMAND_PATTERNS: RegExp[] = [
  /\b(pnpm|npm|yarn)\s+(test|test:run|typecheck|lint|build)\b/i,
  /\b(typecheck|tsc|eslint|prettier)\b/i,
  /\bgo\s+(test|build)\b/i, /\bcargo\s+(test|build)\b/i, /\brustc\b/i,
  /\bpytest\b/i, /\bmvn\s+test\b/i,
];
const DEFAULT_RESULT_PATTERNS: RegExp[] = [
  /\b\d+\s*(\/|of)?\s*\d*\s*(pass|passing)\b/i,
  /\b0\s*(fail|failing|errors?|error)\b/i,
  /\bexit\s*(code\s*)?(:|=|→)?\s*0\b/i,
  /\bclean\b/i, /\bgreen\b/i, /\bok\b/i,
  /\b\d+\s*pass(?:ing)?(?:[,\s]+0\s*fail)?\b/i,
];

export interface ScanResult { passed: boolean; evidence: string; }

/** Pure: scan phase output for verification evidence (command + result). */
export function scanVerificationEvidence(
  text: string,
  opts: { patterns?: RegExp[] } = {},
): ScanResult {
  const commands = opts.patterns ?? DEFAULT_COMMAND_PATTERNS;
  // Custom patterns replace the command set; result detection stays the default unless
  // the caller wants full control (they pass patterns that already encode the result).
  const cmdMatch = commands.find((p) => p.test(text));
  if (!cmdMatch) return { passed: false, evidence: "no verification command output found in phase output" };
  // If custom patterns are provided, treat a command match as sufficient (the pattern encodes the result).
  if (opts.patterns) return { passed: true, evidence: `found evidence matching ${cmdMatch}` };
  const resultMatch = DEFAULT_RESULT_PATTERNS.find((p) => p.test(text));
  if (!resultMatch) return { passed: false, evidence: `verification command found (${cmdMatch}) but no pass/exit result signal — show the command output` };
  // Extract a compact snippet around the command.
  const idx = text.search(cmdMatch);
  const snippet = text.slice(Math.max(0, idx - 10), Math.min(text.length, idx + 80)).replace(/\s+/g, " ").trim();
  return { passed: true, evidence: `found: ${snippet}` };
}

export const verificationBeforeCompletionGate: GateDef = {
  name: "verification-before-completion",
  kind: "predicate",
  onFail: "revise",
  run: async (ctx: GateCtx): Promise<GateResult> => {
    const patterns = (ctx.gateParams as { patterns?: RegExp[] } | undefined)?.patterns;
    const r = scanVerificationEvidence(ctx.spawnRes.finalText, patterns ? { patterns } : {});
    return { gate: "verification-before-completion", kind: "predicate", passed: r.passed, evidence: r.evidence, onFail: "revise" };
  },
};