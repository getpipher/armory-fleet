// src/present/tree.ts — P2: pure lineage-tree layout (spec §5 P2, shape A).
// DFS from roots sorted by sortKey; ├─/└─ connectors from GLYPHS; orphans
// (parent named but absent) and cycle members render after intact roots with
// the ↳ continuation marker. Degrades to flat (empty prefixes) on missing data.
import { GLYPHS } from "./glyphs.ts";

export interface TreeRow<T> {
  row: T;
  /** Prefix to prepend before the row's first glyph: "", "├─ ", "│  └─ ", "↳ ". */
  prefix: string;
}

export function layoutTree<T>(
  rows: T[],
  id: (r: T) => string,
  parentOf: (r: T) => string | null,
  sortKey: (r: T) => number,
): Array<TreeRow<T>> {
  const byId = new Map(rows.map((r) => [id(r), r] as const));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  const marked: T[] = []; // orphans + later cycle recoveries → ↳ prefix
  for (const r of rows) {
    const p = parentOf(r);
    if (p == null) { roots.push(r); continue; }
    if (!byId.has(p)) { marked.push(r); continue; }
    const list = children.get(p) ?? [];
    list.push(r);
    children.set(p, list);
  }
  const bySort = (a: T, b: T): number => sortKey(a) - sortKey(b);
  const out: Array<TreeRow<T>> = [];
  const walk = (kids: T[], ancestorPrefix: string, isRoot = false): void => {
    const sorted = [...kids].sort(bySort);
    sorted.forEach((k, i) => {
      const last = i === sorted.length - 1;
      // Roots render bare (no connector); descendants get ├─/└─ per their last-ness.
      const branch = isRoot ? "" : (last ? GLYPHS.treeLeaf : GLYPHS.treeBranch) + GLYPHS.treeLine + " ";
      out.push({ row: k, prefix: ancestorPrefix + branch });
      const grandkids = children.get(id(k));
      if (grandkids?.length) walk(grandkids, ancestorPrefix + (isRoot ? "" : last ? "   " : GLYPHS.treeVert + "  "));
    });
  };
  walk([...roots].sort(bySort), "", true);
  for (const m of [...marked].sort(bySort)) out.push({ row: m, prefix: GLYPHS.continuation + " " });
  // Cycle recovery: anything DFS never reached (cycle members + their descendants).
  const seen = new Set(out.map((o) => id(o.row)));
  const lost = rows.filter((r) => !seen.has(id(r))).sort(bySort);
  for (const c of lost) out.push({ row: c, prefix: GLYPHS.continuation + " " });
  return out;
}
