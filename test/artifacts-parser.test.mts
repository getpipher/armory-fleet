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