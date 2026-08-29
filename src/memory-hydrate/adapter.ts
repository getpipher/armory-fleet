// src/memory-hydrate/adapter.ts — ONLY file importing @getpipher/armory-memory.
import { renderMemoryBlock, listMemory } from "@getpipher/armory-memory";
import type { MemoryHydratePort, MemoryScopes } from "./port.ts";

export class ArmoryMemoryAdapter implements MemoryHydratePort {
  renderScopes(scopes: MemoryScopes): string {
    return [scopes.project, scopes.local, scopes.user]
      .filter((cwd): cwd is string => cwd != null && listMemory(cwd).length > 0)   // skip empty scopes cleanly (no placeholder to render)
      .map((cwd) => renderMemoryBlock(cwd))           // armory-memory's existing cwd-keyed primitive
      .join("\n\n");                                   // → "" when all three empty
  }
}