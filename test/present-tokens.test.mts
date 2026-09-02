import { test } from "node:test";
import assert from "node:assert/strict";
import { statusToken, fg } from "../src/present/tokens.ts";

const theme = { fg: (t: string, s: string) => `\x1b[35m[${t}]${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };

test("status → token map", () => {
  assert.equal(statusToken("running").fg, "accent");
  assert.equal(statusToken("queued").fg, "dim");
  assert.equal(statusToken("paused").fg, "warning");
  assert.equal(statusToken("completed").fg, "success");
  assert.equal(statusToken("failed").fg, "error");
  assert.equal(statusToken("aborted").fg, "error");
});

test("stale escalates via bold", () => {
  assert.deepEqual(statusToken("stale"), { fg: "warning", bold: true });
});

test("unknown status falls back dim (usage-honesty: never crash on unknown)", () => {
  assert.equal(statusToken("something-new").fg, "dim");
});

test("fg wraps text with theme token", () => {
  assert.equal(fg("running", theme as never, "x"), "\x1b[35m[accent]x\x1b[0m");
  assert.equal(fg("stale", theme as never, "x"), "\x1b[35m[warning]\x1b[1mx\x1b[0m");
});
