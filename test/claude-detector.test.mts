import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectClaude } from "../src/backend/claude-detector.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fixtures", "fake-claude.mjs");

test("detects a healthy claude (schemaOk true, flags probed)", async () => {
  const info = await detectClaude(fakeBin, { schemaProbeArg: "init-ok" });
  ok(info);
  strictEqual(info!.schemaOk, true);
  ok(info!.version.length > 0);
  ok(info!.flagSupport["--disallowed-tools"] === true);
  ok(info!.flagSupport["--resume"] === true);
});

test("returns null when the binary is missing", async () => {
  const info = await detectClaude("/nonexistent/claude-bin");
  strictEqual(info, null);
});

test("returns null when the default `claude` is not on PATH (ENOENT captured)", async () => {
  const origPath = process.env.PATH;
  process.env.PATH = "";   // force spawn ENOENT for the default bin
  try {
    const info = await detectClaude("claude");
    strictEqual(info, null);
  } finally {
    process.env.PATH = origPath;
  }
});

test("schema drift (init missing session_id) → schemaOk false + note", async () => {
  const info = await detectClaude(fakeBin, { schemaProbeArg: "init-drift" });
  ok(info);
  strictEqual(info!.schemaOk, false);
  ok(/drift/i.test(info!.note ?? ""));
});