// src/panel/runs-index.ts
// SPEC-5b-1 — pure scan of the conversations dir → newest-first run list. Pure so the
// Runs tab + unit tests share one path (mirrors buildFleetItems from v0.5.0).
import { RunLog, type RunMeta } from "../runtime/run-log.ts";

export function buildRunsIndex(logDir: string): RunMeta[] {
  return new RunLog(logDir).scanMeta().sort((a, b) => b.startedAt - a.startedAt);
}