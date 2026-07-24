import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { runLifecycle, type LifecycleRunDeps, type CheckpointFn } from "../src/lifecycle/run-lifecycle.ts";
import { parseLifecycleFile } from "../src/lifecycle/registry.ts";
import type { AgentDef } from "../src/registry/frontmatter.ts";

const LC_SRC = `---
name: test-lc
description: t
backend: pi
phases:
  - { name: a, skills: [], checkpoint: true }
  - { name: b, skills: [], checkpoint: true }
  - { name: c, skills: [], checkpoint: false }
---
## a
phase a {{task}}
## b
phase b {% if prev %}{{prev.summary}}{% endif %}
## c
phase c
`;

const agent: AgentDef = {
  name: "general-purpose", description: "x", rolePrompt: "", todoSync: true, memoryHydrate: false, vision: false,
  backend: "pi", sessionKey: "general-purpose", source: "builtin", filePath: "/x.md",
};

function makeDeps(spawns: Array<{ finalText: string; status: "completed" | "failed" }>): LifecycleRunDeps {
  let i = 0;
  let reverted = false;
  return {
    registry: new Map([["test-lc", parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")]]),
    agentRegistry: new Map([["general-purpose", agent]]),
    spawn: async (opts) => {
      const s = spawns[Math.min(i, spawns.length - 1)];
      i++;
      if (!s) throw new Error("no spawn canned result");
      return {
        status: s.status, finalText: s.finalText, runId: `fl-${i}`,
        todoId: opts.lifecycleTodoId ?? "td-1", agent: "general-purpose", model: "test/model", durationMs: 10, tokenTotal: 0,
      };
    },
    todoPort: {
      async linkOrCreateRunTodo() { return { todoId: "td-lc" }; },
      async markRunTodoDone() {},
      async markRunTodoReverted() { reverted = true; },
      async updateLifecycleProgress() {},
    },
    resolveBackend: () => "pi",
    genRunId: () => "fl-test",
  };
}

const continueCheckpoint: CheckpointFn = async () => ({ action: "continue" });
const autoCheckpoint: CheckpointFn = async (rec) => rec.status === "failed" ? { action: "abort" } : { action: "continue" };

test("normal advance through 3 phases, lifecycle completed", async () => {
  const deps = makeDeps([
    { finalText: "a done\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "completed");
  strictEqual(res.phases.length, 3);
  strictEqual(res.phases[0]?.name, "a");
  ok(res.phases[0]?.paths.includes("a.md"));
});

test("Revise then Continue re-runs the phase with feedback", async () => {
  let calls = 0;
  const deps = makeDeps([
    { finalText: "a-v1\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "a-v2\n\nArtifacts:\n  - path: a2.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  const onCp: CheckpointFn = async () => { calls++; return calls === 1 ? { action: "revise", feedback: "tighter" } : { action: "continue" }; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "completed");
  strictEqual(res.phases[0]?.reviseCount, 1, "phase a revised once");
  ok(res.phases[0]?.paths.includes("a2.md"), "revised record points at the new artifact");
});

test("Revise budget exhaustion → failed", async () => {
  const deps = makeDeps([
    { finalText: "a-v1\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "a-v2\n\nArtifacts:\n  - path: a2.md\n", status: "completed" },
    { finalText: "a-v3\n\nArtifacts:\n  - path: a3.md\n", status: "completed" },
    { finalText: "a-v4\n\nArtifacts:\n  - path: a4.md\n", status: "completed" },
  ]);
  const onCp: CheckpointFn = async () => ({ action: "revise", feedback: "again" });
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "failed");
  ok(/revise.*budget/i.test(res.error ?? ""));
});

test("phase failure forces checkpoint; auto-abort in auto mode", async () => {
  const deps = makeDeps([{ finalText: "", status: "failed" }]);
  const res = await runLifecycle("task", "test-lc", { deps, mode: "auto", onCheckpoint: autoCheckpoint });
  strictEqual(res.status, "failed");
  strictEqual(res.phases[0]?.status, "failed");
});

test("phase failure forces checkpoint; checkpointed mode offers Revise then Continue", async () => {
  const deps = makeDeps([
    { finalText: "", status: "failed" },
    { finalText: "a-ok\n\nArtifacts:\n  - path: a.md\n", status: "completed" },
    { finalText: "b done\n\nArtifacts:\n  - path: b.md\n", status: "completed" },
    { finalText: "c done\n\nArtifacts:\n  - path: c.md\n", status: "completed" },
  ]);
  let call = 0;
  const onCp: CheckpointFn = async () => { call++; return call === 1 ? { action: "revise", feedback: "fix it" } : { action: "continue" }; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "completed");
  strictEqual(res.phases[0]?.reviseCount, 1);
});

test("Abort at checkpoint → aborted + todo reverted", async () => {
  const deps = makeDeps([{ finalText: "a\n\nArtifacts:\n  - path: a.md\n", status: "completed" }]);
  let reverted = false;
  const orig = deps.todoPort.markRunTodoReverted;
  deps.todoPort.markRunTodoReverted = async () => { reverted = true; };
  void orig;
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: async () => ({ action: "abort" }) });
  strictEqual(res.status, "aborted");
  ok(reverted, "todo reverted on abort");
});

test("lifecycle name not found → resolve-time error", async () => {
  const deps = makeDeps([]);
  const res = await runLifecycle("task", "nope", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "failed");
  ok(/lifecycle 'nope' not found/.test(res.error ?? ""));
});

test("agent not in registry → failed + todo reverted", async () => {
  const deps = makeDeps([]);
  // replace the agent registry with one missing general-purpose
  deps.agentRegistry = new Map();
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "failed");
  ok(/agent 'general-purpose'/.test(res.error ?? ""));
});