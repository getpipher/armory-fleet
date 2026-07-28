import type { GateDef, GateCtx, GateResult } from "./registry.ts";
import type { SpawnResult } from "../../engine/spawnSubagent.ts";

const FAILURE_MARKERS = /\b(does not meet|not meet|missing|incomplete|not addressed|fails?|broken|incorrect)\b/i;

/** Pure: judge a reviewer's text for a passed/failed verdict. */
export function judgeReview(text: string): { passed: boolean } {
  return { passed: !FAILURE_MARKERS.test(text) };
}

/** Pure: build the reviewer subagent prompt. */
export function buildVerifyPrompt(ctx: GateCtx): string {
  return [
    "You are an independent reviewer. Review this phase's output against the task + plan.",
    `Task: ${ctx.lifecycle.task}`,
    `Phase: ${ctx.phaseRec.name}`,
    `Phase summary: ${ctx.phaseRec.summary}`,
    `Artifacts: ${ctx.phaseRec.paths.join(", ") || "(none)"}`,
    "Did it meet the requirement? What's missing? Be specific. End with a verdict: 'meets the requirement' or 'does not meet the requirement'.",
  ].join("\n");
}

export const verifyGate: GateDef = {
  name: "verify",
  kind: "agent",
  onFail: "advise",
  run: async (ctx: GateCtx): Promise<GateResult> => {
    const reviewerAgent = (ctx.gateParams as { agent?: string } | undefined)?.agent ?? "reviewer";
    const prompt = buildVerifyPrompt(ctx);
    let spawnRes: SpawnResult;
    try {
      spawnRes = await ctx.spawn({ agent: reviewerAgent, task: prompt, lifecycleTodoId: ctx.lifecycle.todoId, skills: [], backend: ctx.lifecycle.backend });
    } catch (e) {
      return { gate: "verify", kind: "agent", passed: false, evidence: `reviewer spawn failed: ${(e as Error).message}`, onFail: "advise" };
    }
    if (spawnRes.status === "failed") {
      return { gate: "verify", kind: "agent", passed: false, evidence: `reviewer spawn failed: ${spawnRes.error ?? spawnRes.finalText.slice(0, 120)}`, onFail: "advise" };
    }
    const verdict = judgeReview(spawnRes.finalText);
    return {
      gate: "verify", kind: "agent", passed: verdict.passed,
      evidence: spawnRes.finalText.slice(0, 2000), onFail: "advise",
      ...(spawnRes.costTotal != null ? { cost: spawnRes.costTotal } : {}),
      runId: spawnRes.runId,
    };
  },
};