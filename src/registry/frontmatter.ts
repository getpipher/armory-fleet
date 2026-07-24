// src/registry/frontmatter.ts
import { parse as parseYaml } from "yaml";
import { basename, extname } from "node:path";

export type AgentSource = "builtin" | "project" | "global";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  source: AgentSource;
  filePath: string;
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

  return {
    name,
    description,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinkingLevel: typeof raw.thinkingLevel === "string" ? (raw.thinkingLevel as ThinkingLevel) : undefined,
    tools: strList(raw.tools),
    skills: strList(raw.skills),
    rolePrompt: body,
    todoSync,
    memoryHydrate,
    vision,
    source,
    filePath,
  };
}