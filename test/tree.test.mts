// test/tree.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutTree } from "../src/present/tree.ts";

interface N { key: string; parent: string | null; at: number }
const n = (key: string, parent: string | null, at = 0): N => ({ key, parent, at });

test("linear chain nests with └─ connectors", () => {
  const out = layoutTree([n("b", "a", 2), n("a", null, 1)], (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => [o.row.key, o.prefix]), [["a", ""], ["b", "└─ "]]);
});

test("branching siblings use ├─ for all but the last", () => {
  const rows = [n("root", null, 0), n("k1", "root", 1), n("k2", "root", 2), n("k3", "root", 3)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => o.prefix), ["", "├─ ", "├─ ", "└─ "]);
});

test("depth-3 continuation prefixes use │  under non-last ancestors", () => {
  const rows = [n("r", null, 0), n("a", "r", 1), n("b", "r", 4), n("a1", "a", 2), n("a2", "a", 3)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => [o.row.key, o.prefix]), [
    ["r", ""], ["a", "├─ "], ["a1", "│  ├─ "], ["a2", "│  └─ "], ["b", "└─ "],
  ]);
});

test("depth-3 under a last child indents with spaces, not │", () => {
  const rows = [n("r", null, 0), n("a", "r", 1), n("a1", "a", 2)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => o.prefix), ["", "└─ ", "   └─ "]);
});

test("orphan (parent named but absent) renders after intact roots with ↳", () => {
  const rows = [n("root", null, 1), n("orph", "ghost", 2)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => [o.row.key, o.prefix]), [["root", ""], ["orph", "↳ "]]);
});

test("cycle members do not hang — recovered as ↳ after intact rows", () => {
  const rows = [n("r", null, 0), n("x", "y", 1), n("y", "x", 2)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => [o.row.key, o.prefix]), [["r", ""], ["x", "↳ "], ["y", "↳ "]]);
});

test("multi-root sorts by sortKey; siblings sort by sortKey", () => {
  const rows = [n("z", null, 9), n("a", null, 1), n("m", "z", 5), n("k", "z", 2)];
  const out = layoutTree(rows, (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(out.map((o) => o.row.key), ["a", "z", "k", "m"]);
});

test("empty input → empty output; all-null parents → flat empty prefixes", () => {
  assert.deepEqual(layoutTree([], (r: N) => r.key, (r) => r.parent, (r) => r.at), []);
  const flat = layoutTree([n("a", null), n("b", null, 1)], (r) => r.key, (r) => r.parent, (r) => r.at);
  assert.deepEqual(flat.map((o) => o.prefix), ["", ""]);
});
