// src/backend/claude-detector.ts — version + stream-json schema smoke + flag-support probe (SPEC-3 §5).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mapClaudeEvent } from "./claude-events.ts";
import type { BackendVersionInfo } from "./registry.ts";

const DEFAULT_BIN = "claude";

export interface DetectOpts {
  /** Fixture hook: an arg passed to the fake-claude via FLEET_FAKE_CLAUDE_PROBE env to select init-ok/init-drift. */
  schemaProbeArg?: string;
}

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    // Capture the spawn error message into stderr so the caller can detect ENOENT (binary missing).
    child.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: null }));
  });
}

function parseVersion(stdout: string): string {
  const m = stdout.trim().match(/(\d+\.\d+\.\d+)/);
  return m && m[1] ? m[1] : stdout.trim();
}

function probeFlags(helpText: string): Record<string, boolean> {
  const has = (flag: string): boolean => new RegExp(`(^|\\s)${flag.replace(/-/g, "\\-")}(\\s|$)`).test(helpText);
  return {
    "--disallowed-tools": has("--disallowed-tools"),
    "--allowed-tools": has("--allowed-tools"),
    "--max-turns": has("--max-turns"),
    "--resume": has("--resume"),
    "--append-system-prompt": has("--append-system-prompt"),
    "--output-format": has("--output-format"),
  };
}

export async function detectClaude(bin: string = DEFAULT_BIN, opts: DetectOpts = {}): Promise<BackendVersionInfo | null> {
  // Missing binary check: for an explicit path that doesn't exist, return null;
  // for the default `claude` on PATH, the version run below resolves ENOENT → null.
  if (bin !== DEFAULT_BIN && !existsSync(bin)) return null;
  const versionRun = await run(bin, ["--version"]);
  if (versionRun.code === null && /ENOENT/i.test(versionRun.stderr)) return null;
  if (versionRun.code !== 0 && !versionRun.stdout) {
    return { version: "", schemaOk: false, flagSupport: {}, note: `claude --version failed (code ${versionRun.code})` };
  }
  const version = parseVersion(versionRun.stdout);

  // Schema smoke: spawn a throwaway ping in stream-json mode; scan the lines for a `system/init` event with session_id.
  // (Real CC emits hook_started/hook_response system events before init; first-line-only would false-fail.)
  const env = opts.schemaProbeArg ? { FLEET_FAKE_CLAUDE_PROBE: opts.schemaProbeArg } : undefined;
  const smoke = await run(bin, ["-p", "--verbose", "--output-format", "stream-json", "ping"], env);
  let schemaOk = false;
  let note: string | undefined;
  const lines = smoke.stdout.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const ev = mapClaudeEvent(line);
    if (ev && ev.type === "session_init" && ev.backendSessionId) { schemaOk = true; break; }
  }
  if (!schemaOk) {
    note = lines.length ? `schema drift (no init event with session_id; first line: ${lines[0]!.slice(0, 80)})` : "schema drift (no output emitted)";
  }

  // Flag-support probe (only meaningful if --help works).
  const helpRun = await run(bin, ["--help"]);
  const flagSupport = helpRun.code === 0 ? probeFlags(helpRun.stdout) : {};

  return { version, schemaOk, flagSupport, note };
}