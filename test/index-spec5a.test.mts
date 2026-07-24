// test/index-spec5a.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanResumeCandidates } from "../src/runtime/resume.ts";
import { createFleetResultsTool } from "../src/tools/fleet-results.ts";
import { ResultsInbox } from "../src/runtime/results-inbox.ts";

test("the SPEC-5a runtime surface is re-exported (smoke — full init needs a pi context)", () => {
  assert.equal(typeof scanResumeCandidates, "function");
  assert.equal(typeof createFleetResultsTool, "function");
});

test("the fleet.results tool wires against an inbox", () => {
  const inbox = new ResultsInbox();
  const tool = createFleetResultsTool({ inbox });
  assert.equal(tool.name, "fleet_results");
});

test("index.ts loads without syntax error (import smoke)", async () => {
  // Dynamic import exercises the module graph including the SPEC-5a wiring.
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.default, "function");
});