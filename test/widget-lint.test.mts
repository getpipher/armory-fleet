// test/widget-lint.test.mts
// SPEC-5b-2 regression guard (added in the post-v0.9.2 widget-lint follow-up).
//
// The stale-widget bug class: a `ctx.ui.setWidget(key, [...])` call that sets a
// widget but never clears it (`setWidget(key, undefined)`) on completion/dispose.
// This bit fleet twice:
//   - SPEC-1 (commit 26454af): the subagent tool set `setWidget("fleet", ["▶ … · running"])`
//     on every turn_end and never cleared it → stale "▶ general-purpose · running" lingered
//     above the editor after the run finished. Removed in v0.9.2 (PR #11).
//   - SPEC-5b-2: a below-editor `fleet-view` widget duplicated the above-editor widget
//     (redundant, not stale, but the same "widget proliferation" smell). Removed in v0.9.2.
//
// The architectural invariant that prevents the stale-widget class: **all `setWidget`
// calls go through `FleetWidgetController`** (src/panel/fleet-widget.ts), which owns a
// disciplined set/clear lifecycle (set on active, clear on idle + dispose). Any `setWidget`
// call elsewhere is a smell — it bypasses the lifecycle and risks never being cleared.
//
// This test enforces the invariant by scanning src/ for `.setWidget(` call sites and
// asserting they only appear in fleet-widget.ts. If a future feature needs a widget, it
// must add it to the controller (or a sibling controller with the same set/clear
// discipline), not call setWidget ad-hoc.

import { test } from "node:test";
import { strictEqual, fail } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const ALLOWED_FILE = join("panel", "fleet-widget.ts"); // the single sanctioned setWidget surface

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("setWidget call sites only appear in fleet-widget.ts (stale-widget regression guard)", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (rel === ALLOWED_FILE) continue;
    const src = readFileSync(file, "utf8");
    // Match `.setWidget(` — catches ctx.ui.setWidget, this.deps.ui.setWidget, etc.
    // Ignore commented-out lines (a // line that mentions setWidget is not a call).
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) continue;
      if (/\.setWidget\s*\(/.test(line)) {
        offenders.push(`${rel}: ${trimmed.slice(0, 80)}`);
      }
    }
  }
  if (offenders.length > 0) {
    fail(
      `setWidget called outside fleet-widget.ts (the single sanctioned widget surface).\n` +
      `This is the stale-widget bug class — a setWidget without a matching clear on completion.\n` +
      `Add the widget to FleetWidgetController (src/panel/fleet-widget.ts) instead, which owns\n` +
      `the set/clear lifecycle (set on active, clear on idle + dispose).\n` +
      `Offenders:\n  - ` + offenders.join("\n  - "),
    );
  }
  strictEqual(offenders.length, 0, "no ad-hoc setWidget calls outside the controller");
});

test("FleetWidgetController sets exactly one widget key (no widget proliferation)", () => {
  const src = readFileSync(join(SRC, ALLOWED_FILE), "utf8");
  // The controller should declare exactly one WIDGET_KEY const + use it.
  // (v0.9.2 removed the second VIEW_KEY/"fleet-view" below-editor widget.)
  const keyConsts = src.match(/const\s+\w*KEY\w*\s*=\s*"[^"]+"/g) ?? [];
  strictEqual(keyConsts.length, 1, `expected exactly one widget-key const, found: ${keyConsts.join(", ")}`);
  strictEqual(keyConsts[0], 'const WIDGET_KEY = "fleet-active"', `the one key is fleet-active`);
});