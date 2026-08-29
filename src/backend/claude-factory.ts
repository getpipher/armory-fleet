// src/backend/claude-factory.ts — createClaudeChildFactory (SPEC-3 §4.1, §4.5, §4.6, §9.1).
import { spawn, type ChildProcess } from "node:child_process";
import type { ChildSessionFactory, ChildSessionOpts } from "../engine/spawnSubagent.ts";
import type { BackendVersionInfo } from "./registry.ts";
import type { ResumeStore } from "./resume-store.ts";
import { ClaudeChildSession } from "./claude-session.ts";
import { memoryScopesFor } from "../engine/child-loader.ts";

export interface ClaudeFactoryOverrides {
  /** Test hook: called instead of `spawn` to inspect args. Returns a ChildProcess-shaped stub. */
  spawnOverride?: (args: string[]) => ChildProcess;
}

export function createClaudeChildFactory(
  detector: BackendVersionInfo | null,
  resumeStore: ResumeStore,
  bin: string = "claude",
  overrides: ClaudeFactoryOverrides = {},
): ChildSessionFactory {
  return {
    async create(opts: ChildSessionOpts): Promise<{ session: ClaudeChildSession; model: string }> {
      if (!detector?.schemaOk) {
        throw new Error(`claude backend unavailable: ${detector?.note ?? "schema not ok"}`);
      }
      const memoryBlock = opts.agent.memoryHydrate ? opts.memoryPort.renderScopes(memoryScopesFor(opts.cwd, { includeUser: opts.agent.userMemory ?? false })) : "";
      const sys = memoryBlock ? `${opts.rolePrompt}\n\n${memoryBlock}` : opts.rolePrompt;
      const resumeId = resumeStore.get("claude", opts.agent.sessionKey);

      const args: string[] = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
      if (opts.model) args.push("--model", opts.model);
      args.push("--append-system-prompt", sys);
      // todo exclusion: prefer --disallowed-tools; fall back to --allowed-tools allow-list when the agent pins tools.
      if (detector.flagSupport["--disallowed-tools"]) {
        args.push("--disallowed-tools", "todo");
      } else if (detector.flagSupport["--allowed-tools"] && opts.tools.length) {
        const allowed = opts.tools.filter((t) => t !== "todo").join(",");
        args.push("--allowed-tools", allowed);
      }
      // v0.3 leaves maxTurns to the engine's turn_end belt (no --max-turns flag; avoids double-enforcement).
      if (resumeId && detector.flagSupport["--resume"]) args.push("--resume", resumeId);
      args.push(opts.task);

      const proc = overrides.spawnOverride
        ? overrides.spawnOverride(args)
        : spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const session = new ClaudeChildSession(proc, opts.agent.sessionKey, resumeStore);
      return { session, model: opts.model ?? "" };
    },
  };
}