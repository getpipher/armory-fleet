/** Status → theme-token map (spec §2). Pure; theme-shaped param keeps this unit-testable. */
export type TokenName = "accent" | "dim" | "warning" | "success" | "error";

const MAP: Record<string, { fg: TokenName; bold?: boolean }> = {
  running: { fg: "accent" },
  queued: { fg: "dim" },
  paused: { fg: "warning" },
  completed: { fg: "success" },
  failed: { fg: "error" },
  aborted: { fg: "error" },
  stale: { fg: "warning", bold: true },
};

export function statusToken(status: string): { fg: TokenName; bold?: boolean } {
  return MAP[status] ?? { fg: "dim" };   // unknown future statuses degrade gracefully
}

interface FgTheme { fg(t: string, s: string): string; bold(s: string): string }

export function fg(status: string, theme: FgTheme, s: string): string {
  const { fg: token, bold } = statusToken(status);
  return theme.fg(token, bold ? "\x1b[1m" + s : s);
}
