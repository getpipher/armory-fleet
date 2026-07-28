import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseTiersFile, type Tier } from "./tier-registry.ts";

export interface TierStoreOpts { projectPath: string; globalPath: string; }

export class TierStore {
  constructor(private readonly opts: TierStoreOpts) {}
  read(scope: "project" | "global"): Tier[] {
    const path = scope === "project" ? this.opts.projectPath : this.opts.globalPath;
    try { return parseTiersFile(readFileSync(path, "utf8")); } catch { return []; }
  }
  write(scope: "project" | "global", tiers: Tier[]): void {
    const json = JSON.stringify(tiers, null, 2);
    parseTiersFile(json);  // throws on invalid — no file change
    const path = scope === "project" ? this.opts.projectPath : this.opts.globalPath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, path);  // atomic
  }
}