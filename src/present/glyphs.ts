/** Single glyph vocabulary (spec §2). Nothing renders a glyph not defined here.
 *  All glyphs screened against Unicode Extended_Pictographic (emoji-free) — ▶ ⏳ ⏸ ↗ ⓘ ☾ ⚠ ☑ ☐
 *  are Misc-Symbols/Arrows blocks, NOT Extended_Pictographic, so they pass the emoji screen.
 *  P3: presets — unicode (default) / nerd (FontAwesome PUA icons) / ascii (dumb terminals).
 *  Selection: ARMORY_FLEET_GLYPHS env var, read once at module load (ratified static resolve). */
export interface GlyphMap {
  status: { running: string; queued: string; paused: string; completed: string; failed: string; aborted: string };
  spinner: string[];
  treeBranch: string; treeLeaf: string; treeLine: string; treeVert: string;
  continuation: string; crossCwd: string; ellipsis: string;
  cardTL: string; cardTR: string; cardBL: string; cardBR: string; cardH: string; cardV: string;
  info: string; waiting: string;
  eventDot: string; filesTouched: string;
  gatePass: string; gateFail: string; gateRevise: string; gateWarn: string;
  todoDone: string; todoOpen: string; todoStruck: string;
  /** P3: segmented footer hint separator (unicode/nerd `│`, ascii `|`). */
  footerSep: string;
}

export function unicodePreset(): GlyphMap {
  return {
    status: { running: "▶", queued: "⏳", paused: "⏸", completed: "✓", failed: "✗", aborted: "✗" },
    spinner: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
    treeBranch: "├", treeLeaf: "└", treeLine: "─", treeVert: "│",
    continuation: "↳", crossCwd: "↗", ellipsis: "…",
    cardTL: "╭", cardTR: "╮", cardBL: "╰", cardBR: "╯", cardH: "─", cardV: "│",
    info: "ⓘ", waiting: "☾",
    eventDot: "●", filesTouched: "✎",
    gatePass: "✓", gateFail: "✗", gateRevise: "↻", gateWarn: "⚠",
    todoDone: "☑", todoOpen: "☐", todoStruck: "̶",
    footerSep: "│",
  };
}

export function asciiPreset(): GlyphMap {
  return {
    status: { running: ">", queued: ".", paused: "||", completed: "v", failed: "x", aborted: "x" },
    spinner: ["-", "\\", "|", "/"],
    treeBranch: "|", treeLeaf: "\\", treeLine: "-", treeVert: "|",
    continuation: ">", crossCwd: ">", ellipsis: "...",
    cardTL: "+", cardTR: "+", cardBL: "+", cardBR: "+", cardH: "-", cardV: "|",
    info: "i", waiting: "~",
    gatePass: "v", gateFail: "x", gateRevise: "@", gateWarn: "!",
    todoDone: "[x]", todoOpen: "[ ]", todoStruck: "-",
    eventDot: "*", filesTouched: "+",
    footerSep: "|",
  };
}

/** Nerd preset: FontAwesome PUA icons (U+F000–F2E0 — the range nerd-fonts has guaranteed
 *  stable since v1). Tree/card box-drawing + continuation + todoStruck stay unicode:
 *  connectors render fine in nerd fonts — nerd's value-add is icons, not connectors.
 *  Spinner frames are smoke-verified candidates; visual pick happens in the real-pi
 *  smoke (RECTOR eyeballs), swaps are data-only. */
export function nerdPreset(): GlyphMap {
  return {
    status: { running: "\uF04B", queued: "\uF017", paused: "\uF04C", completed: "\uF00C", failed: "\uF00D", aborted: "\uF00D" },
    spinner: ["\uF110", "\uF021", "\uF1CE", "\uF013"],
    treeBranch: "├", treeLeaf: "└", treeLine: "─", treeVert: "│",
    continuation: "↳", crossCwd: "\uF08E", ellipsis: "\uF141",
    cardTL: "╭", cardTR: "╮", cardBL: "╰", cardBR: "╯", cardH: "─", cardV: "│",
    info: "\uF05A", waiting: "\uF186",
    eventDot: "\uF111", filesTouched: "\uF040",
    gatePass: "\uF00C", gateFail: "\uF00D", gateRevise: "\uF021", gateWarn: "\uF071",
    todoDone: "\uF046", todoOpen: "\uF096", todoStruck: "̶",
    footerSep: "│",
  };
}

export type PresetName = "unicode" | "nerd" | "ascii";

const PRESETS: Record<PresetName, () => GlyphMap> = { unicode: unicodePreset, nerd: nerdPreset, ascii: asciiPreset };

/** Env → preset name. Trimmed + lowercased; absent/empty/unknown → "unicode". */
export function resolvePresetName(env: string | undefined): PresetName {
  const v = env?.trim().toLowerCase();
  if (v === "nerd") return "nerd";
  if (v === "ascii") return "ascii";
  return "unicode";
}

/** Static resolve (ratified: no runtime switching). Unknown non-empty env warns exactly once. */
export function pickPreset(env: string | undefined): GlyphMap {
  const name = resolvePresetName(env);
  const raw = env?.trim() ?? "";
  if (raw !== "" && raw.toLowerCase() !== name) {
    console.error(`[armory-fleet] unknown ARMORY_FLEET_GLYPHS value "${raw}" — using "${name}" preset`);
  }
  return PRESETS[name]();
}

export const GLYPHS: GlyphMap = pickPreset(process.env.ARMORY_FLEET_GLYPHS);

export function spinnerFrame(i: number): string {
  const idx = ((i % GLYPHS.spinner.length) + GLYPHS.spinner.length) % GLYPHS.spinner.length;
  return GLYPHS.spinner[idx] ?? GLYPHS.spinner[0]!; // array index widening under noUncheckedIndexedAccess (annotation-only)
}
