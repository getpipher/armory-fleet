import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { parseArtifacts, MAX_REVISE } from "../src/lifecycle/artifacts-parser.ts";

test("parses a well-formed Artifacts block", () => {
  const r = parseArtifacts("I did the work.\n\nArtifacts:\n  - path: a.md\n    kind: design\n  - path: b.md\n    kind: plan\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.summary, "I did the work.");
  strictEqual(r.paths.length, 2);
  strictEqual(r.paths[0], "a.md");
});

test("summary is the text before the Artifacts block, trimmed", () => {
  const r = parseArtifacts("  leading text here  \n\nArtifacts:\n  - path: x.md\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.summary, "leading text here");
});

test("missing Artifacts block on a non-terminal phase = error", () => {
  const r = parseArtifacts("no artifacts here", { terminal: false });
  ok("error" in r);
  ok(/missing.*Artifacts/i.test(r.error));
});

test("missing Artifacts block on a terminal phase = ok (exemption)", () => {
  const r = parseArtifacts("merged the PR", { terminal: true });
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.summary, "merged the PR");
  strictEqual(r.paths.length, 0);
});

test("malformed YAML in Artifacts block = error", () => {
  const r = parseArtifacts("work\n\nArtifacts:\n  - path: [unclosed\n", { terminal: false });
  ok("error" in r);
  ok(/malformed/i.test(r.error));
});

test("Artifacts block with no paths = error on non-terminal (needs at least one)", () => {
  const r = parseArtifacts("work\n\nArtifacts: []\n", { terminal: false });
  ok("error" in r);
  ok(/no paths/i.test(r.error));
});

test("MAX_REVISE is 3", () => { strictEqual(MAX_REVISE, 3); });
test("parses a fenced (```yaml) Artifacts block with trailing prompt-echo", () => {
  const r = parseArtifacts("brainstorm output\n\n```yaml\nArtifacts:\n  - path: design.md\n    kind: design\n```\n\n---\n\n📌 YOUR PROMPT: do the thing\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.paths.length, 1);
  strictEqual(r.paths[0], "design.md");
  ok(r.summary.startsWith("brainstorm output"));
});

test("parses a plain-fenced (```) Artifacts block", () => {
  const r = parseArtifacts("work\n\n```\nArtifacts:\n  - path: a.ts\n  - path: b.ts\n```\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.paths.length, 2);
});

test("trims a trailing thematic break (---) in an unfenced block", () => {
  const r = parseArtifacts("work\n\nArtifacts:\n  - path: a.ts\n    kind: src\n\n---\n\nfooter noise\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.paths.length, 1);
  strictEqual(r.paths[0], "a.ts");
});

test("ignores an 'Artifacts:' inside a trailing prompt-echo (parses the real block)", () => {
  const r = parseArtifacts("design text\n\nArtifacts:\n```yaml\n- path: design.md\n  kind: design\n```\n\n---\n\n📌 YOUR PROMPT: end with an `Artifacts:` block (YAML)\n");
  if ("error" in r) throw new Error("expected ok, got: " + r.error);
  strictEqual(r.paths.length, 1);
  strictEqual(r.paths[0], "design.md");
  ok(r.summary.startsWith("design text"), "summary is the real pre-block text, not the echo");
});
