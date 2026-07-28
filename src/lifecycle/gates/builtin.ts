// src/lifecycle/gates/builtin.ts
import type { GateRegistry } from "./registry.ts";
import { verificationBeforeCompletionGate } from "./verification-before-completion.ts";
import { completenessCheckGate } from "./completeness-check.ts";
import { gateGate } from "./gate.ts";
import { verifyGate } from "./verify.ts";

/** Register the 4 builtin gates on a GateRegistry. */
export function registerBuiltinGates(reg: GateRegistry): void {
  reg.register(verificationBeforeCompletionGate);
  reg.register(completenessCheckGate);
  reg.register(gateGate);
  reg.register(verifyGate);
}