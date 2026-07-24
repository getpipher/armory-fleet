import { test } from "node:test";
import { ok } from "node:assert";

test("index default export is the extension entry + /fleet-implement registered shape (smoke via import)", async () => {
  const mod = await import("../src/index.ts");
  ok(typeof mod.default === "function", "default export is the extension entry");
  // Full wiring (lifecycle registry built, slash registered, deps threaded) is exercised by
  // the term-driven smoke (docs/SPEC-4-smoke-checklist.md); this test guards the export shape +
  // that the module loads without throwing on import.
});