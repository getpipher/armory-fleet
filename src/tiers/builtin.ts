import type { Tier } from "./tier-registry.ts";

/** Shipped default tiers (Q10). Overridable via global/project tiers.json. */
export const BUILTIN_TIERS: Tier[] = [
  { name: "economy",  models: ["Ollama/minimax-m3:cloud"] },
  { name: "standard", models: ["Ollama/glm-5.2:cloud", "Ollama/minimax-m3:cloud"] },
  { name: "frontier", models: ["anthropic/claude-sonnet-4", "Ollama/glm-5.2:cloud"], costCap: 5, contextFloor: 200000 },
];