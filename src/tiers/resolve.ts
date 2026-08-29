import type { AgentDef } from "../registry/frontmatter.ts";
import type { Tier, TierRegistry } from "./tier-registry.ts";

/** Narrow port over pi's ModelRegistry — only the lookup 6-1 needs. */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): { contextWindow: number } | undefined;
}

export interface ResolvedModel {
  model: string;
  tier?: Tier;
  /** Pre-filtered eligible candidates (primary first); spawnSubagent retries these on create() rejection. */
  candidates?: string[];
}

export interface ResolveError { error: string; model?: undefined; }

/** Split "provider/modelId" on the first "/". Bare id → { parentProvider, id }. */
export function splitModel(model: string, parentProvider = ""): { provider: string; id: string } {
  const i = model.indexOf("/");
  if (i < 0) return { provider: parentProvider, id: model };
  return { provider: model.slice(0, i), id: model.slice(i + 1) };
}

/** Q4 precedence: optsModel > agent.tier > agent.model > parent. Q5: contextFloor + catalog filter. */
export function resolveAgentModel(
  agent: AgentDef, optsModel: string | undefined,
  parentModel: { provider: string; id: string },
  tiers: TierRegistry, modelRegistry: ModelRegistryLike,
): ResolvedModel | ResolveError {
  if (optsModel) return { model: optsModel };
  if (agent.tier) {
    const tier = tiers.get(agent.tier);
    if (!tier) return { error: `tier '${agent.tier}' not found; available: ${tiers.list().map((t) => t.name).join(", ")}` };
    const candidates: string[] = [];
    for (const m of tier.models) {
      if (m.trim().toLowerCase() === "inherit") {
        // #64: "inherit" = use the parent/active model — always eligible, no catalog or
        // contextFloor check (the session model is presumed appropriate; the floor guards
        // concrete candidates). Participates in the chain: eligible concrete models listed
        // before it win; after them it acts as the provider-agnostic fallback.
        // Sentinel is case-insensitive/trimmed; concrete model strings stay verbatim.
        // Empty parentModel (dispatch before a session model exists) is NOT pushed — a
        // pure-inherit tier then falls to the descriptive no-eligible-model error below.
        if (parentModel.provider || parentModel.id) {
          const parent = `${parentModel.provider}/${parentModel.id}`;
          if (!candidates.includes(parent)) candidates.push(parent);
        }
        continue;
      }
      const { provider, id } = splitModel(m, parentModel.provider);
      const model = modelRegistry.find(provider, id);
      if (!model) continue;                                              // not in catalog → skip
      if (tier.contextFloor && (model.contextWindow ?? 0) < tier.contextFloor) continue;  // below floor → skip
      candidates.push(m);
    }
    if (candidates.length === 0) {
      return { error: `tier '${tier.name}': no eligible model (all missing or below contextFloor ${tier.contextFloor ?? "—"})` };
    }
    return { model: candidates[0]!, tier, candidates };
  }
  if (agent.model) return { model: agent.model };
  return { model: `${parentModel.provider}/${parentModel.id}` };
}