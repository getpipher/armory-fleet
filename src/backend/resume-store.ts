// src/backend/resume-store.ts — file-backed sessionKey -> backendSessionId, per backend (SPEC-3 §2.4, §4.3).
// Hardened against cross-session/cross-cwd result contamination (#102).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function rootDir(): string {
  return process.env.FLEET_RESUME_ROOT ?? join(process.env.HOME ?? "/tmp", ".pi", "agent", "cache", "fleet-resume");
}

/** Per-backend JSON map: { [scopedKey]: backendSessionId }. */
function fileFor(backendId: string): string {
  return join(rootDir(), `${backendId}.json`);
}

function readMap(backendId: string): Record<string, string> {
  const f = fileFor(backendId);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(backendId: string, m: Record<string, string>): void {
  const dir = rootDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(backendId), JSON.stringify(m, null, 2));
}

export class ResumeStore {
  private readonly defaultCwd?: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd;
  }

  private scopeKey(sessionKey: string, cwd?: string): string {
    const activeCwd = cwd ?? this.defaultCwd;
    if (!activeCwd) return sessionKey;
    const cwdHash = createHash("sha256").update(activeCwd).digest("hex").slice(0, 12);
    return `${cwdHash}:${sessionKey}`;
  }

  get(backendId: string, sessionKey: string, cwd?: string): string | null {
    const key = this.scopeKey(sessionKey, cwd);
    return readMap(backendId)[key] ?? null;
  }

  set(backendId: string, sessionKey: string, backendSessionId: string, cwd?: string): void {
    const key = this.scopeKey(sessionKey, cwd);
    const m = readMap(backendId);
    m[key] = backendSessionId;
    writeMap(backendId, m);
  }

  clear(backendId: string, sessionKey: string, cwd?: string): void {
    const key = this.scopeKey(sessionKey, cwd);
    const m = readMap(backendId);
    delete m[key];
    writeMap(backendId, m);
  }
}
