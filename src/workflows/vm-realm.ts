// SPEC-6-3 §3.1 — the vm sandbox realm. Determinism, NOT security (PRD §6: trusted-dev-environment).
// JS-only workflow scripts (no .ts → no transpile). Strips Date/Math.random/require/import/fs/net/timers/eval;
// injects the 5 orchestration globals + 7 helpers + realm globals (log/args/cwd/process.cwd/budget).
import vm from "node:vm";

export interface RealmDeps {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  pipeline: (items: unknown[], ...stages: Array<(item: unknown) => Promise<unknown>>) => Promise<unknown[]>;
  phase: (title: string, opts?: { budget?: number }) => void;
  workflow: (name: string, args?: unknown) => Promise<unknown>;
  verify: (item: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  judgePanel: (attempts: unknown[], opts?: Record<string, unknown>) => Promise<unknown>;
  loopUntilDry: (opts: Record<string, unknown>) => Promise<unknown[]>;
  completenessCheck: (taskArgs: unknown, results: unknown) => Promise<unknown>;
  gate: (thunk: (feedback: string | undefined, attempt: number) => unknown, validator: (v: unknown) => { ok: boolean; feedback?: string }, opts?: Record<string, unknown>) => Promise<unknown>;
  retry: (thunk: (attempt: number) => unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  checkpoint: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;
  log: (message: unknown) => void;
  args: unknown;
  cwd: string;
  budget: { total: number; spent: () => number; remaining: () => number };
}

export const REALM_GLOBAL_NAMES = [
  "agent", "parallel", "pipeline", "phase", "workflow",
  "verify", "judgePanel", "loopUntilDry", "completenessCheck", "gate", "retry", "checkpoint",
  "log", "args", "cwd", "process", "budget",
] as const;

/** Build a vm context with the injected globals + stripped non-determinism. */
export function buildRealm(deps: RealmDeps): vm.Context {
  const sandbox: Record<string, unknown> = {
    // 5 orchestration globals
    agent: deps.agent,
    parallel: deps.parallel,
    pipeline: deps.pipeline,
    phase: deps.phase,
    workflow: deps.workflow,
    // 7 helpers
    verify: deps.verify,
    judgePanel: deps.judgePanel,
    loopUntilDry: deps.loopUntilDry,
    completenessCheck: deps.completenessCheck,
    gate: deps.gate,
    retry: deps.retry,
    checkpoint: deps.checkpoint,
    // realm globals
    log: deps.log,
    args: deps.args,
    cwd: deps.cwd,
    budget: deps.budget,
    // process.cwd() returns the session cwd (deterministic); no process.env.
    process: { cwd: () => deps.cwd },
    // CommonJS module surface so scripts can `module.exports = …`
    module: { exports: {} as unknown },
    exports: undefined as unknown,
    // async + Promise must be present for the script to use await
    Promise,
    // console absent (log() is the channel) — but provide a noop for accidental use
    console: { log: deps.log, error: deps.log, warn: deps.log, info: deps.log },
  };
  // Fix: extract typed locals so we can alias `exports` without `unknown` errors.
  const mod = sandbox.module as { exports: unknown };
  sandbox.exports = mod.exports;
  // JSON + the bare operators need nothing extra; but `JSON` is a global — provide it
  sandbox.JSON = JSON;
  // Symbol/Array/Object/Number/String/Boolean/Math (for JSON.stringify/Array.from etc.) —
  // but we STRIP Math.random + Date by NOT providing them. Provide the safe builtins:
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.String = String;
  sandbox.Number = Number;
  sandbox.Boolean = Boolean;
  sandbox.Symbol = Symbol;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.Error = Error;
  sandbox.RegExp = RegExp;
  sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat;
  sandbox.isNaN = isNaN;
  sandbox.isFinite = isFinite;
  // Deliberately NOT provided (determinism contract): Date, Math, require, import,
  // setTimeout, setInterval, setImmediate, fetch, globalThis, process.env, eval, Function.
  // vm.createContext provides builtins (Date, Math, timers, eval, etc.) regardless of
  // sandbox contents — shadow them with throwing getters so any access throws ReferenceError.
  // process is NOT here: we inject `process: { cwd: () => deps.cwd }` above, and the spec
  // strips process.env (not process.cwd). Exclude process from the strip set.
  const STRIPPED = ["Date", "Math", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "eval", "Function", "globalThis", "fetch", "require"] as const;
  for (const name of STRIPPED) {
    Object.defineProperty(sandbox, name, {
      get() { throw new ReferenceError(`${name} is not defined`); },
      set() { throw new ReferenceError(`${name} is not defined`); },
      configurable: false,
      enumerable: false,
    });
  }
  return vm.createContext(sandbox, { name: "armory-fleet-workflow" });
}

/** Compile a JS workflow script. JS-only — a .ts script is rejected upstream. */
export function compileWorkflowScript(script: string): vm.Script {
  // Wrap so the script can use `module.exports = …` (CommonJS) OR an async IIFE.
  return new vm.Script(script, { filename: "workflow.js" });
}
