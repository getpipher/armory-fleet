// test/fleet-settings.test.mts
// #78: fleet-dir settings.json — global + project merge, strict validation with
// actionable warnings (never a silent swallow — the TierStore ENOENT lesson).
import { test } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFleetSettings, FleetSettingsStore } from "../src/settings/fleet-settings.ts";

test("parseFleetSettings: empty object → no settings, no warnings", () => {
  const r = parseFleetSettings("{}");
  deepStrictEqual(r.settings, {});
  deepStrictEqual(r.warnings, []);
});

test("parseFleetSettings: valid defaultSubagentThinking accepted (all union values)", () => {
  for (const v of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const r = parseFleetSettings(JSON.stringify({ defaultSubagentThinking: v }));
    strictEqual(r.settings.defaultSubagentThinking, v, `value ${v}`);
    deepStrictEqual(r.warnings, [], `value ${v} must not warn`);
  }
});

test("parseFleetSettings: invalid thinking value → warning + field dropped", () => {
  const r = parseFleetSettings(JSON.stringify({ defaultSubagentThinking: "ultra" }), "settings.json");
  strictEqual(r.settings.defaultSubagentThinking, undefined);
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes("defaultSubagentThinking"), "names the field");
  ok(r.warnings[0]!.includes("ultra"), "shows the bad value");
  ok(r.warnings[0]!.includes("settings.json"), "names the source file");
});

test("parseFleetSettings: non-string thinking value → warning + field dropped", () => {
  const r = parseFleetSettings(JSON.stringify({ defaultSubagentThinking: 3 }));
  strictEqual(r.settings.defaultSubagentThinking, undefined);
  ok(r.warnings.length === 1 && r.warnings[0]!.includes("defaultSubagentThinking"));
});

test("parseFleetSettings: unknown key → warning, valid sibling kept", () => {
  const r = parseFleetSettings(JSON.stringify({ defualtThinking: "low", defaultSubagentThinking: "high" }));
  strictEqual(r.settings.defaultSubagentThinking, "high");
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes("defualtThinking"), "names the unknown key");
});

test("parseFleetSettings: invalid JSON → warning + empty settings", () => {
  const r = parseFleetSettings("{ not json", "x.json");
  deepStrictEqual(r.settings, {});
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes("x.json"));
});

test("parseFleetSettings: non-object root (array/string/number) → warning + empty", () => {
  for (const bad of ["[1,2]", '"str"', "42", "null"]) {
    const r = parseFleetSettings(bad);
    deepStrictEqual(r.settings, {}, bad);
    strictEqual(r.warnings.length, 1, bad);
  }
});

test("store.load: missing files → empty settings, no warnings (absence is normal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const store = new FleetSettingsStore({
      globalPath: join(dir, "nope", "global.json"),
      projectPath: join(dir, "nope", "project.json"),
    });
    const r = store.load();
    deepStrictEqual(r.settings, {});
    deepStrictEqual(r.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: global used when no project override", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    writeFileSync(g, JSON.stringify({ defaultSubagentThinking: "high" }));
    const store = new FleetSettingsStore({ globalPath: g, projectPath: join(dir, "missing.json") });
    const r = store.load();
    strictEqual(r.settings.defaultSubagentThinking, "high");
    deepStrictEqual(r.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: project wins per-field over global", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, JSON.stringify({ defaultSubagentThinking: "max" }));
    writeFileSync(p, JSON.stringify({ defaultSubagentThinking: "low" }));
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    strictEqual(store.load().settings.defaultSubagentThinking, "low");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: project lacking the field falls through to global", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, JSON.stringify({ defaultSubagentThinking: "medium" }));
    writeFileSync(p, "{}");
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    strictEqual(store.load().settings.defaultSubagentThinking, "medium");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: warnings collected from BOTH files with source labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, JSON.stringify({ defaultSubagentThinking: "nope" }));
    writeFileSync(p, "{ broken");
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    const r = store.load();
    deepStrictEqual(r.settings, {});
    strictEqual(r.warnings.length, 2);
    ok(r.warnings.some((w) => w.includes("global.json")));
    ok(r.warnings.some((w) => w.includes("project.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: unreadable (non-ENOENT) file → actionable warning, not silence", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    mkdirSync(join(dir, "not-a-file"), { recursive: true }); // directory at the path → EISDIR
    const store = new FleetSettingsStore({
      globalPath: join(dir, "not-a-file"),
      projectPath: join(dir, "missing.json"),
    });
    const r = store.load();
    deepStrictEqual(r.settings, {});
    strictEqual(r.warnings.length, 1);
    ok(r.warnings[0]!.includes("not-a-file"), "names the path");
    ok(r.warnings[0]!.includes("EISDIR"), "names the errno code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store.load: corrupt global does not shadow a valid project value", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    mkdirSync(dir, { recursive: true });
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, "{ nope");
    writeFileSync(p, JSON.stringify({ defaultSubagentThinking: "high" }));
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    const r = store.load();
    strictEqual(r.settings.defaultSubagentThinking, "high");
    strictEqual(r.warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseFleetSettings: mcpDeny valid entries parse through (bare server + server__tool)", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: ["github", "github__delete_repo", "internal-tools"] }));
  deepStrictEqual(r.settings.mcpDeny, ["github", "github__delete_repo", "internal-tools"]);
  deepStrictEqual(r.warnings, []);
});

test("parseFleetSettings: mcpDeny invalid entries warn + drop per-entry, valid entries stay enforced", () => {
  const r = parseFleetSettings(
    JSON.stringify({ mcpDeny: ["github__delete_repo", "", "a__", "__b", "server__*", 42] }),
    "settings.json",
  );
  deepStrictEqual(r.settings.mcpDeny, ["github__delete_repo"]);
  strictEqual(r.warnings.length, 5);
  for (const w of r.warnings) {
    ok(w.startsWith("settings.json: mcpDeny entry"), `actionable + file-labeled: ${w}`);
  }
});

test("parseFleetSettings: mcpDeny non-array value warns + field dropped", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: "github" }), "settings.json");
  strictEqual(r.settings.mcpDeny, undefined);
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes("mcpDeny must be an array of strings"));
});

test("parseFleetSettings: mcpDeny empty array is valid (explicit no-op list)", () => {
  const r = parseFleetSettings(JSON.stringify({ mcpDeny: [] }));
  deepStrictEqual(r.settings.mcpDeny, []);
  deepStrictEqual(r.warnings, []);
});

test("parseFleetSettings: mcpDeny itself is a known key; sibling typos still warn", () => {
  const r = parseFleetSettings(
    JSON.stringify({ mcpDeny: ["github"], mcpDenyTypo: ["x"] }),
    "settings.json",
  );
  strictEqual(r.warnings.length, 1);
  ok(r.warnings[0]!.includes('unknown setting "mcpDenyTypo"'));
});

test("store.load: mcpDeny project wins per-field over global (whole-field replacement)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  try {
    const g = join(dir, "global.json");
    const p = join(dir, "project.json");
    writeFileSync(g, JSON.stringify({ mcpDeny: ["global-only"] }));
    writeFileSync(p, JSON.stringify({ mcpDeny: ["project-only"] }));
    const store = new FleetSettingsStore({ globalPath: g, projectPath: p });
    deepStrictEqual(store.load().settings.mcpDeny, ["project-only"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
