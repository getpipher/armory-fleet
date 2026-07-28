import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { renderPhasePrompt, CHALLENGE_STEP_BLOCK, type PromptVars } from "../src/lifecycle/prompt-template.ts";

test("renders {{task}} and {{lifecycle}}/{{phase}}", () => {
  const out = renderPhasePrompt("Task: {{task}} | lc={{lifecycle}} ph={{phase}}", {
    task: "fix bug", lifecycle: "default", phase: "plan", challengeStep: false,
  });
  strictEqual(out, "Task: fix bug | lc=default ph=plan");
});

test("renders prev block when prev is present, omits when absent", () => {
  const t = "{% if prev %}prev: {{prev.name}} {{prev.summary}} paths={{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan", challengeStep: false, prev: { name: "brainstorm", summary: "did it", paths: ["a.md", "b.md"] } }),
    "prev: brainstorm did it paths=- a.md\n- b.md");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "brainstorm", challengeStep: false }), "");
});

test("renders feedback block only when feedback present", () => {
  const t = "{% if feedback %}FB: {{feedback}}{% endif %}end";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement", challengeStep: false, feedback: "tighter" }), "FB: tighterend");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement", challengeStep: false }), "end");
});

test("prev.paths renders as a newline-separated list, empty string when no paths", () => {
  const t = "{% if prev %}{{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", challengeStep: false, prev: { name: "a", summary: "s", paths: [] } }), "");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", challengeStep: false, prev: { name: "a", summary: "s", paths: ["only.md"] } }), "- only.md");
});

test("Revise feedback includes prior-attempt digest", () => {
  const t = "{% if feedback %}{{feedback}}{% endif %}";
  const out = renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan", challengeStep: false,
    feedback: "Prior attempt summary: first try\n\nHuman feedback: be more concrete" });
  if (!out.includes("Human feedback: be more concrete")) throw new Error("missing human feedback");
  if (!out.includes("first try")) throw new Error("missing prior attempt digest");
});

test("challenge-step: injected by default", () => {
  const out = renderPhasePrompt("## implement\nDo the work.", {
    task: "t", lifecycle: "default", phase: "implement",
  });
  ok(out.includes(CHALLENGE_STEP_BLOCK), "challenge-step block appended when challengeStep not set");
});

test("challenge-step: omitted when challengeStep === false", () => {
  const out = renderPhasePrompt("## finish\nMerge.", {
    task: "t", lifecycle: "default", phase: "finish", challengeStep: false,
  });
  ok(!out.includes(CHALLENGE_STEP_BLOCK), "no challenge-step when opted out");
});

test("challenge-step: block contains the self-critique directive", () => {
  ok(CHALLENGE_STEP_BLOCK.includes("What could break?"));
  ok(CHALLENGE_STEP_BLOCK.includes("challenge"));
});