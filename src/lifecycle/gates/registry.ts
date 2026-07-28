import type { PhaseRecord } from "../lifecycle-types.ts";
import type { SpawnResult } from "../../engine/spawnSubagent.ts";
import type { SpawnFn } from "../run-lifecycle.ts";
import type { BackendId } from "../lifecycle-types.ts";
import type { Tier } from "../../tiers/tier-registry.ts";

export type GateKind = "agent" | "predicate";
export type GateOnFail = "advise" | "revise" | "abort";

/** What a phase declares in frontmatter. String = name only; object = name + overrides. */
export type GateRef = string | { name: string; onFail?: GateOnFail; params?: Record<string, unknown> };

/** A resolved gate definition (registry entry + phase overrides applied). */
export interface GateDef {
  name: string;
  kind: GateKind;
  onFail: GateOnFail;
  params?: Record<string, unknown>;
  run: (ctx: GateCtx) => Promise<GateResult>;
}

export interface GateCtx {
  phaseRec: PhaseRecord;
  spawnRes: SpawnResult;
  lifecycle: { name: string; task: string; todoId: string; backend: BackendId };
  tier?: Tier;
  /** Sum of costTotal across all runs linked to this lifecycle's todoId. */
  lifecycleCost: number;
  contextTokens: number;
  worktreePath?: string;
  /** Agent gates use this to spawn the reviewer subagent. */
  spawn: SpawnFn;
  getModelContextWindow: (model: string) => number | undefined;
  /** Per-gate params from the resolved GateDef (set by the chain runner). */
  gateParams?: Record<string, unknown>;
}

export interface GateResult {
  gate: string;
  kind: GateKind;
  passed: boolean;
  evidence: string;
  onFail: GateOnFail;
  /** Agent gates only — the spawned run's costTotal. */
  cost?: number;
  /** Agent gates only — links to the /fleet row. */
  runId?: string;
  durationMs?: number;
}

export class GateRegistry {
  private readonly byName = new Map<string, GateDef>();
  register(def: GateDef): void {
    if (this.byName.has(def.name)) throw new Error(`duplicate gate name '${def.name}'`);
    this.byName.set(def.name, def);
  }
  get(name: string): GateDef | undefined { return this.byName.get(name); }
  list(): GateDef[] { return [...this.byName.values()]; }
}

/** Resolve phase-declared GateRefs into GateDefs, applying per-phase onFail/params overrides. */
export function resolveGates(refs: GateRef[] | undefined, reg: GateRegistry): GateDef[] {
  if (!refs || refs.length === 0) return [];
  return refs.map((ref) => {
    const name = typeof ref === "string" ? ref : ref.name;
    const base = reg.get(name);
    if (!base) throw new Error(`unknown gate '${name}' (not in registry)`);
    if (typeof ref === "string") return base;
    return {
      ...base,
      ...(ref.onFail ? { onFail: ref.onFail } : {}),
      ...(ref.params ? { params: { ...base.params, ...ref.params } } : {}),
    };
  });
}