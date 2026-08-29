// src/backend/claude-session.ts — ChildSession over a claude -p child process (SPEC-3 §4.4, §4.3).
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildSession, ChildSessionEvent } from "../engine/spawnSubagent.ts";
import { mapClaudeEvents } from "./claude-events.ts";
import type { ResumeStore } from "./resume-store.ts";

export class ClaudeChildSession implements ChildSession {
  private readonly proc: ChildProcess;
  private readonly sessionKey: string;
  private readonly resumeStore: ResumeStore;
  private readonly handlers: Array<(e: ChildSessionEvent) => void> = [];
  private disposed = false;
  private initCaptured = false;
  private turnResolve: (() => void) | null = null;

  constructor(proc: ChildProcess, sessionKey: string, resumeStore: ResumeStore) {
    this.proc = proc;
    this.sessionKey = sessionKey;
    this.resumeStore = resumeStore;
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.onLine(line));
    proc.on("close", () => { if (this.turnResolve) { const r = this.turnResolve; this.turnResolve = null; r(); } });
  }

  private onLine(line: string): void {
    for (const ev of mapClaudeEvents(line)) {
      if (ev.type === "session_init" && ev.backendSessionId && !this.initCaptured) {
        this.initCaptured = true;
        this.resumeStore.set("claude", this.sessionKey, ev.backendSessionId);
      }
      if (ev.type === "turn_end" || ev.type === "error") {
        if (this.turnResolve) { this.turnResolve(); this.turnResolve = null; }
      }
      for (const h of this.handlers) h(ev);
    }
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (!this.proc.stdin) throw new Error("claude child has no stdin pipe");
    const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    return new Promise<void>((resolve) => {
      this.turnResolve = resolve;
      this.proc.stdin!.write(msg, () => { /* fire-and-forget; resolved on turn_end/close */ });
    });
  }

  subscribe(handler: (e: ChildSessionEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  async abort(): Promise<void> {
    if (this.disposed) return;
    try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    this.disposed = true;   // SIGTERM kills the child process; the session is irrecoverable
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
    this.proc.stdout?.destroy();
    try { this.proc.stdin?.end(); } catch { /* already closed */ }
    this.proc.removeAllListeners();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** SPEC-6-2: cross-process liveness probe — is the claude child proc still running? */
  isAlive(): boolean {
    return !this.disposed && this.proc.killed === false && this.proc.exitCode === null && this.proc.signalCode === null;
  }
}