// src/registry/frontmatter.ts
import { parse as parseYaml } from "yaml";
import { basename, extname } from "node:path";

export type AgentSource = "builtin" | "project" | "global";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Type guard for the closed ThinkingLevel enum. #90: canonical home is HERE, next to
 *  the type; fleet-settings imports + re-exports it for its settings-field guard. */
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  rolePrompt: string;
  todoSync: boolean;
  memoryHydrate: boolean;
  vision: boolean;
  /** #20/SPEC-6-5: opt in to the global cross-project user memory scope (`/__armory-fleet-user__`).
   *  Default false — the user scope is a cross-project bleed by construction; hydrate it only when
   *  an agent explicitly declares `userMemory: true`. Only meaningful when `memoryHydrate: true`. */
  userMemory: boolean;
  /** Cross-harness backend routing (SPEC-3). Invalid value → FrontmatterError. */
  backend: "pi" | "claude";
  /** Stable id for backend-native resume (SPEC-3). Defaults to name. */
  sessionKey: string;
  source: AgentSource;
  filePath: string;
  /** SPEC-6-1: cost-aware model tier (overrides agent.model when set). */
  tier?: string;
}

export class FrontmatterError extends Error {
  override name = "FrontmatterError" as const;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseAgentFile(content: string, filePath: string, source: AgentSource): AgentDef {
  const m = FRONTMATTER_RE.exec(content);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new FrontmatterError(`${filePath}: missing --- frontmatter delimiters`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new FrontmatterError(`${filePath}: invalid YAML (${(e as Error).message})`);
  }
  const body = m[2];

  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : basename(filePath, extname(filePath));
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) throw new FrontmatterError(`${filePath}: description is required`);

  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)) : undefined;

  const todoSync = raw.todoSync === undefined ? true : Boolean(raw.todoSync);
  const memoryHydrate = raw.memoryHydrate === undefined ? true : Boolean(raw.memoryHydrate);
  const vision = raw.vision === undefined ? true : Boolean(raw.vision);
  const userMemory = raw.userMemory === undefined ? false : Boolean(raw.userMemory);

  const rawBackend = typeof raw.backend === "string" ? raw.backend.trim() : "pi";
  if (rawBackend !== "pi" && rawBackend !== "claude") {
    throw new FrontmatterError(`${filePath}: invalid backend '${rawBackend}' (must be 'pi' | 'claude')`);
  }
  const backend = rawBackend as "pi" | "claude";
  const sessionKey = typeof raw.sessionKey === "string" && raw.sessionKey.trim() ? raw.sessionKey.trim() : name;

  // #90: thinkingLevel is a closed enum — same value class as backend, same contract:
  // trim-then-validate, an invalid value throws FrontmatterError (discovery catches →
  // warning + skip), never a silent no-op. `null` (YAML empty value) counts as absent.
  const rawThinking: unknown = raw.thinkingLevel;
  let thinkingLevel: ThinkingLevel | undefined;
  if (rawThinking !== undefined && rawThinking !== null) {
    const candidate = typeof rawThinking === "string" ? rawThinking.trim() : rawThinking;
    if (!isThinkingLevel(candidate)) {
      throw new FrontmatterError(
        `${filePath}: invalid thinkingLevel ${JSON.stringify(rawThinking)} (must be one of ${THINKING_LEVELS.join("|")})`,
      );
    }
    thinkingLevel = candidate;
  }

  return {
    name,
    description,
    model: typeof raw.model === "string" ? raw.model : undefined,
    tier: typeof raw.tier === "string" ? raw.tier : undefined,
    thinkingLevel,
    tools: strList(raw.tools),
    skills: strList(raw.skills),
    rolePrompt: body,
    todoSync,
    memoryHydrate,
    vision,
    userMemory,
    backend,
    sessionKey,
    source,
    filePath,
  };
}