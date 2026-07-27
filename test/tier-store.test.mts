import { test, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, throws, deepStrictEqual } from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TierStore } from "../src/tiers/tier-store.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-tstore-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("read: missing file → [] (scope degrades cleanly)", () => {
  const store = new TierStore({ projectPath: join(dir, "tiers.json"), globalPath: join(dir, "global-tiers.json") });
  deepStrictEqual(store.read("project"), []);
});

test("write+read roundtrip: project scope", () => {
  const store = new TierStore({ projectPath: join(dir, "tiers.json"), globalPath: join(dir, "g.json") });
  store.write("project", [{ name: "x", models: ["m"] }]);
  deepStrictEqual(store.read("project"), [{ name: "x", models: ["m"] }]);
  ok(existsSync(join(dir, "tiers.json")), "file written");
});

test("write rejects duplicates → no file change", () => {
  const store = new TierStore({ projectPath: join(dir, "tiers.json"), globalPath: join(dir, "g.json") });
  store.write("project", [{ name: "x", models: ["m"] }]);
  throws(() => store.write("project", [{ name: "x", models: ["m1"] }, { name: "x", models: ["m2"] }]), /duplicate/);
  deepStrictEqual(store.read("project"), [{ name: "x", models: ["m"] }], "file unchanged after rejected write");
});