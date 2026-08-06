// test/workflow-builtin-tiers.test.mts
// #47 guard: the 5 builtin workflows' `tier: 'X'` names must resolve against BUILTIN_TIERS.
// Regression guard — the builtins previously used 'low'/'medium' which don't exist in BUILTIN_TIERS
// (economy/standard/frontier), so every agent() call failed (returned null) + the workflows did nothing.
import { test } from "node:test";
import { ok, strictEqual } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TIERS } from "../src/tiers/builtin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(here, "..", "src", "workflows", "builtin");
const validTiers = new Set(BUILTIN_TIERS.map((t) => t.name));

test("#47: every builtin workflow uses tier names that resolve against BUILTIN_TIERS", () => {
  const files = readdirSync(builtinDir).filter((f) => f.endsWith(".js"));
  ok(files.length >= 5, `expected ≥5 builtin workflows; found ${files.length}`);
  const tierRe = /tier:\s*['"]([a-z]+)['"]/g;
  let totalRefs = 0;
  for (const f of files) {
    const src = readFileSync(join(builtinDir, f), "utf8");
    for (const m of src.matchAll(tierRe)) {
      totalRefs++;
      const tierName = m[1]!;
      ok(validTiers.has(tierName), `${f}: tier '${tierName}' is not a BUILTIN_TIERS name (valid: ${[...validTiers].join(", ")})`);
    }
  }
  ok(totalRefs > 0, "the builtins should reference at least one tier (guard against the regex drifting)");
});

test("#47: the builtins no longer use the old 'low'/'medium'/'high' tier names", () => {
  // Explicit regression guard: the renamed-away names must not reappear.
  const files = readdirSync(builtinDir).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const src = readFileSync(join(builtinDir, f), "utf8");
    ok(!/tier:\s*['"]low['"]/.test(src), `${f}: still uses tier 'low' (renamed to 'economy')`);
    ok(!/tier:\s*['"]medium['"]/.test(src), `${f}: still uses tier 'medium' (renamed to 'standard')`);
    ok(!/tier:\s*['"]high['"]/.test(src), `${f}: still uses tier 'high' (renamed to 'frontier')`);
  }
});

test("#47: BUILTIN_TIERS defines economy/standard/frontier (the names the builtins use)", () => {
  const names = BUILTIN_TIERS.map((t) => t.name).sort();
  strictEqual(names.join(","), "economy,frontier,standard");
});
