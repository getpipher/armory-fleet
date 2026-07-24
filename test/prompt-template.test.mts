import { test } from "node:test";
import { strictEqual } from "node:assert";
import { renderPhasePrompt, type PromptVars } from "../src/lifecycle/prompt-template.ts";

test("renders {{task}} and {{lifecycle}}/{{phase}}", () => {
  const out = renderPhasePrompt("Task: {{task}} | lc={{lifecycle}} ph={{phase}}", {
    task: "fix bug", lifecycle: "default", phase: "plan",
  });
  strictEqual(out, "Task: fix bug | lc=default ph=plan");
});

test("renders prev block when prev is present, omits when absent", () => {
  const t = "{% if prev %}prev: {{prev.name}} {{prev.summary}} paths={{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan", prev: { name: "brainstorm", summary: "did it", paths: ["a.md", "b.md"] } }),
    "prev: brainstorm did it paths=- a.md\n- b.md");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "brainstorm" }), "");
});

test("renders feedback block only when feedback present", () => {
  const t = "{% if feedback %}FB: {{feedback}}{% endif %}end";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement", feedback: "tighter" }), "FB: tighterend");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "implement" }), "end");
});

test("prev.paths renders as a newline-separated list, empty string when no paths", () => {
  const t = "{% if prev %}{{prev.paths}}{% endif %}";
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", prev: { name: "a", summary: "s", paths: [] } }), "");
  strictEqual(renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "p", prev: { name: "a", summary: "s", paths: ["only.md"] } }), "- only.md");
});

test("Revise feedback includes prior-attempt digest", () => {
  const t = "{% if feedback %}{{feedback}}{% endif %}";
  const out = renderPhasePrompt(t, { task: "x", lifecycle: "d", phase: "plan",
    feedback: "Prior attempt summary: first try\n\nHuman feedback: be more concrete" });
  if (!out.includes("Human feedback: be more concrete")) throw new Error("missing human feedback");
  if (!out.includes("first try")) throw new Error("missing prior attempt digest");
});