// src/backend/resume-store.ts — file-backed sessionKey → backendSessionId, per backend (SPEC-3 §2.4, §4.3).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rootDir(): string {
  return process.env.FLEET_RESUME_ROOT ?? join(process.env.HOME ?? "/tmp", ".pi", "agent", "cache", "fleet-resume");
}

/** Per-backend JSON map: { [sessionKey]: backendSessionId }. */
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
  get(backendId: string, sessionKey: string): string | null {
    return readMap(backendId)[sessionKey] ?? null;
  }
  set(backendId: string, sessionKey: string, backendSessionId: string): void {
    const m = readMap(backendId);
    m[sessionKey] = backendSessionId;
    writeMap(backendId, m);
  }
  clear(backendId: string, sessionKey: string): void {
    const m = readMap(backendId);
    delete m[sessionKey];
    writeMap(backendId, m);
  }
}