export interface Tier {
  name: string;
  models: string[];          // ordered fallback chain, primary first
  costCap?: number;          // $ per-run; abort when run.costTotal exceeds
  contextFloor?: number;     // min contextWindow; skip models below it at spawn
}

export class TierFileError extends Error {
  override name = "TierFileError" as const;
}

/** Parse a raw JSON string into validated Tier[]. Empty/blank → []. */
export function parseTiersFile(raw: string): Tier[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new TierFileError("malformed tiers file (invalid JSON)"); }
  if (!Array.isArray(parsed)) throw new TierFileError("tiers file must be a JSON array of tier objects");
  const seen = new Set<string>();
  return parsed.map((t) => {
    const obj = t as Record<string, unknown>;
    const name = obj.name;
    const models = obj.models;
    if (typeof name !== "string" || !name.trim()) throw new TierFileError("tier missing name");
    if (!Array.isArray(models)) throw new TierFileError("tier missing models");
    if (models.length === 0) throw new TierFileError(`tier '${name}' has empty models`);
    if (seen.has(name)) throw new TierFileError(`duplicate tier name '${name}'`);
    seen.add(name);
    return {
      name, models: models.map(String),
      ...(typeof obj.costCap === "number" ? { costCap: obj.costCap } : {}),
      ...(typeof obj.contextFloor === "number" ? { contextFloor: obj.contextFloor } : {}),
    };
  });
}

/** Merge tiers by name: builtins < global < project (later scopes win by name). */
export function mergeTiers(builtin: Tier[], globalTiers: Tier[], project: Tier[]): Tier[] {
  const map = new Map<string, Tier>();
  for (const t of builtin) map.set(t.name, t);
  for (const t of globalTiers) map.set(t.name, t);
  for (const t of project) map.set(t.name, t);
  return [...map.values()];
}

export interface TierRegistryOpts {
  tiers: Tier[];
  /** Agent defs keyed by agent name — only the `tier` field is read, for `usedBy`. */
  agents: Map<string, { tier?: string }>;
}

export class TierRegistry {
  private readonly byName = new Map<string, Tier>();
  private readonly agents: Map<string, { tier?: string }>;
  constructor(opts: TierRegistryOpts) {
    for (const t of opts.tiers) this.byName.set(t.name, t);
    this.agents = opts.agents;
  }
  get(name: string): Tier | undefined { return this.byName.get(name); }
  list(): Tier[] { return [...this.byName.values()]; }
  usedBy(name: string): string[] {
    const out: string[] = [];
    for (const [agentName, def] of this.agents) if (def.tier === name) out.push(agentName);
    return out.sort();
  }
}