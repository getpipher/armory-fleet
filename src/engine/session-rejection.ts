// src/engine/session-rejection.ts
// #84: typed rejections for the live-session control path (steer/abort). The RPC verbs
// previously classified failures by fragile message-substring matching; the handles now
// throw this class and the verbs match on `reason` first. Message TEXT is unchanged at
// the existing throw sites — string matching survives as a back-compat fallback for
// third-party ChildSession implementations that bubble bare Errors.
export type SessionRejectionReason =
  | "steer-unsupported"   // the backend has no steer (e.g. claude children)
  | "already-processing"  // the session is mid-turn and cannot take the steer now
  | "already-aborted";    // the session was already stopped

export class SessionRejectionError extends Error {
  readonly reason: SessionRejectionReason;
  constructor(reason: SessionRejectionReason, message: string) {
    super(message);
    this.name = "SessionRejectionError";
    this.reason = reason;
  }
}

export function isSessionRejection(e: unknown): e is SessionRejectionError {
  return e instanceof SessionRejectionError;
}
