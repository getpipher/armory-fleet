// src/present/width.ts
/** ANSI-aware width helpers (spec §5 P1 prerequisite: .length lies once labels carry SGR codes). */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate to visible `width`, preserving ANSI state (re-emit active SGR after the cut). */
export function truncateToWidth(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let seen = 0;
  const active: string[] = [];
  let i = 0;
  while (i < s.length) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) {
      active.push(m[0]);
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (seen >= width - 1) break;   // reserve 1 col for the ellipsis
    out += s[i];
    seen++;
    i++;
  }
  return out + "…";
}

/** Semantic task excerpt: cut at the last break (":" / space) within width when one exists. */
export function excerpt(s: string, width: number): string {
  const flat = stripAnsi(s);
  if (flat.length <= width) return s;
  const slice = flat.slice(0, width);
  for (const brk of [": ", " "]) {
    const at = slice.lastIndexOf(brk);
    if (at > width * 0.5) return slice.slice(0, at) + "…";
  }
  return slice + "…";
}
