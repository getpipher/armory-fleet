/** Single glyph vocabulary (spec §2). Nothing renders a glyph not defined here.
 *  All glyphs screened against Unicode Extended_Pictographic (emoji-free) — ▶ ⏳ ⏸ ↗ ⓘ ☾ ⚠ ☑ ☐
 *  are Misc-Symbols/Arrows blocks, NOT Extended_Pictographic, so they pass the emoji screen. */
export const GLYPHS = {
  status: { running: "▶", queued: "⏳", paused: "⏸", completed: "✓", failed: "✗", aborted: "✗" },
  spinner: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  treeBranch: "├", treeLeaf: "└", treeLine: "─", treeVert: "│",
  continuation: "↳", crossCwd: "↗", ellipsis: "…",
  cardTL: "╭", cardTR: "╮", cardBL: "╰", cardBR: "╯", cardH: "─", cardV: "│",
  info: "ⓘ", waiting: "☾",
  gatePass: "✓", gateFail: "✗", gateRevise: "↻", gateWarn: "⚠",
  todoDone: "☑", todoOpen: "☐", todoStruck: "̶",
} as const;

export function spinnerFrame(i: number): string {
  const idx = ((i % GLYPHS.spinner.length) + GLYPHS.spinner.length) % GLYPHS.spinner.length;
  return GLYPHS.spinner[idx] ?? GLYPHS.spinner[0];
}

/** P3 preset, defined now so preset-completeness is testable from day one. */
export function asciiPreset() {
  return {
    status: { running: ">", queued: ".", paused: "||", completed: "v", failed: "x", aborted: "x" },
    spinner: ["-", "\\", "|", "/"],
    treeBranch: "|", treeLeaf: "\\", treeLine: "-", treeVert: "|",
    continuation: ">", crossCwd: ">", ellipsis: "...",
    cardTL: "+", cardTR: "+", cardBL: "+", cardBR: "+", cardH: "-", cardV: "|",
    info: "i", waiting: "~",
    gatePass: "v", gateFail: "x", gateRevise: "@", gateWarn: "!",
    todoDone: "[x]", todoOpen: "[ ]", todoStruck: "-",
  };
}
