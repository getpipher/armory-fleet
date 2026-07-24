import { test } from "node:test";
import { ok } from "node:assert";
import type {
  LifecycleStatus, PhaseDef, LifecycleDef, PhaseRecord, LifecycleRunRecord,
  CheckpointDecision, CheckpointAction,
} from "../src/lifecycle/lifecycle-types.ts";

test("lifecycle types are importable + structurally sound", () => {
  const phase: PhaseDef = {
    name: "brainstorm",
    skills: ["brainstorming"],
    agent: "general-purpose",
    backend: "pi",
    checkpoint: true,
    promptTemplate: "You are the brainstorm phase. Task: {{task}}",
  };
  const def: LifecycleDef = {
    name: "default",
    description: "superpowers-5",
    backend: "pi",
    phases: [phase],
    source: "builtin",
    filePath: "<builtin>",
  };
  const rec: PhaseRecord = { name: "brainstorm", summary: "did it", paths: ["a.md"], status: "completed", reviseCount: 0 };
  const run: LifecycleRunRecord = {
    runId: "fl-x", lifecycleName: "default", task: "t", backend: "pi", mode: "checkpointed",
    status: "running", phases: [rec], startedAt: 0, endedAt: undefined, todoId: "td-1",
  };
  const d: CheckpointDecision = { action: "continue" };
  const d2: CheckpointDecision = { action: "revise", feedback: "tighter" };
  const d3: CheckpointDecision = { action: "abort" };
  ok(def.phases.length === 1);
  ok(run.phases[0]?.name === "brainstorm");
  ok((d.action === "continue") && (d2.action === "revise") && (d3.action === "abort"));
});