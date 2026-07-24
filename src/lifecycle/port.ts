// src/lifecycle/port.ts
export { parseLifecycleFile, discoverLifecycles, LifecycleParseError } from "./registry.ts";
export type { LifecycleDiscoverOpts, LifecycleDiscoverResult } from "./registry.ts";
export type {
  LifecycleStatus, LifecycleMode, BackendId, PhaseDef, LifecycleDef, PhaseRecord,
  LifecycleRunRecord, CheckpointAction, CheckpointDecision,
} from "./lifecycle-types.ts";