// src/backend/registry.ts — BackendRegistry + Backend descriptor (SPEC-3 §2.1).
import type { ChildSessionFactory } from "../engine/spawnSubagent.ts";
import type { BackendHookParity } from "./hook-parity.ts";

export interface BackendVersionInfo {
  version: string;
  schemaOk: boolean;
  /** Flag support matrix probed at detect time (kebab-case flag → supported?). */
  flagSupport: Record<string, boolean>;
  note?: string;
}

export interface Backend {
  id: "pi" | "claude";
  factory: ChildSessionFactory;
  available: () => boolean;
  versionInfo: () => BackendVersionInfo | null;
  hookParity: BackendHookParity;
}

export class BackendRegistry {
  private readonly backends = new Map<string, Backend>();
  private readonly order: string[] = [];

  register(b: Backend): void {
    if (!this.backends.has(b.id)) this.order.push(b.id);
    this.backends.set(b.id, b);
  }
  get(id: string): Backend | undefined {
    return this.backends.get(id);
  }
  /** Registration-order list — the data source for the Backends view + engine lookup. */
  list(): Backend[] {
    return this.order.map((id) => this.backends.get(id)!).filter(Boolean);
  }
}