// src/lifecycle/prompt-template.ts
import type { PhaseRecord } from "./lifecycle-types.ts";

export const CHALLENGE_STEP_BLOCK = [
  "",
  "## Challenge Step",
  "After completing significant work, actively challenge your own output before presenting it.",
  'Ask: "What could break? What did I miss? What would a critical reviewer flag?"',
  "Fix what you find — don't just note it. Small single-line changes are exempt.",
  "",
].join("\n");

export interface PromptVars {
  task: string;
  lifecycle: string;
  phase: string;
  /** Previous phase record (absent on phase 1). */
  prev?: { name: string; summary: string; paths: string[] };
  /** On Revise only: human feedback + prior-attempt digest. */
  feedback?: string;
  /** SPEC-6-2: opt out of challenge-step prompt injection. Default true (append). */
  challengeStep?: boolean;
}

/** Render a phase prompt template. Supports {{task}}, {{lifecycle}}, {{phase}},
 *  {{prev.name}}, {{prev.summary}}, {{prev.paths}}, {{feedback}}, and
 *  {% if prev %}…{% endif %} / {% if feedback %}…{% endif %} conditional blocks. */
export function renderPhasePrompt(template: string, vars: PromptVars): string {
  let out = template;

  // {% if prev %}…{% endif %}
  out = out.replace(/{%\s*if\s*prev\s*%}([\s\S]*?){%\s*endif\s*%}/g,
    vars.prev ? "$1" : "");
  // {% if feedback %}…{% endif %}
  out = out.replace(/{%\s*if\s*feedback\s*%}([\s\S]*?){%\s*endif\s*%}/g,
    vars.feedback ? "$1" : "");

  // {{prev.paths}} → newline-separated "- path" list (or empty)
  const pathsStr = vars.prev ? vars.prev.paths.map((p) => `- ${p}`).join("\n") : "";

  out = out
    .replace(/{{\s*task\s*}}/g, vars.task)
    .replace(/{{\s*lifecycle\s*}}/g, vars.lifecycle)
    .replace(/{{\s*phase\s*}}/g, vars.phase)
    .replace(/{{\s*prev\.name\s*}}/g, vars.prev?.name ?? "")
    .replace(/{{\s*prev\.summary\s*}}/g, vars.prev?.summary ?? "")
    .replace(/{{\s*prev\.paths\s*}}/g, pathsStr)
    .replace(/{{\s*feedback\s*}}/g, vars.feedback ?? "");

  const challengeStep = vars.challengeStep !== false;  // default true
  return challengeStep ? out + CHALLENGE_STEP_BLOCK : out;
}