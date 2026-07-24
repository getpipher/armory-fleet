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
test("revise feedback includes the CURRENT phase's prior attempt summary (not the previous phase's)", async () => {
  // Sequence: a completes ("a-done"); b v1 produces "b-v1-bad" → revise; b v2 produces "b-v2-good"
  // → continue; c completes. The revise prompt (3rd spawn) must include "b-v1-bad" (b's OWN prior),
  // NOT "a-done" (the previous phase's summary).
  const prompts: string[] = [];
  const returns = [
    "a-done\n\nArtifacts:\n  - path: a.md\n",
    "b-v1-bad\n\nArtifacts:\n  - path: b1.md\n",
    "b-v2-good\n\nArtifacts:\n  - path: b2.md\n",
    "c-done\n\nArtifacts:\n  - path: c.md\n",
  ];
  let i = 0;
  const deps: LifecycleRunDeps = {
    registry: new Map([["test-lc", parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")]]),
    agentRegistry: new Map([["general-purpose", agent]]),
    spawn: async (opts) => { prompts.push(opts.task); const ft = returns[Math.min(i, 3)]!; i++; return { status: "completed" as const, finalText: ft, runId: "fl-x", todoId: opts.lifecycleTodoId, agent: "general-purpose", model: "m", durationMs: 1, tokenTotal: 0 }; },
    todoPort: { async linkOrCreateRunTodo() { return { todoId: "td" }; }, async markRunTodoDone() {}, async markRunTodoReverted() {}, async updateLifecycleProgress() {} },
    resolveBackend: () => "pi",
    genRunId: () => "fl-test",
  };
  let cpCall = 0;
  const onCp: CheckpointFn = async () => { cpCall++; return cpCall === 1 ? { action: "revise", feedback: "fix b" } : { action: "continue" }; };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: onCp });
  strictEqual(res.status, "completed");
  strictEqual(prompts.length, 4, "4 spawns: a, b-v1, b-v2 (revised), c");
  const revisedPrompt = prompts[2]!;
  ok(revisedPrompt.includes("b-v1-bad"), "revise feedback includes the current phase's own prior attempt summary (b-v1-bad)");
});

test("resolveBackend throwing (claude unavailable) → failed lifecycle + reverted todo, no unhandled rejection", async () => {
  let reverted = false;
  const deps: LifecycleRunDeps = {
    registry: new Map([["test-lc", parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")]]),
    agentRegistry: new Map([["general-purpose", agent]]),
    spawn: async () => { throw new Error("should not spawn — backend resolve fails first"); },
    todoPort: { async linkOrCreateRunTodo() { return { todoId: "td" }; }, async markRunTodoDone() {}, async markRunTodoReverted() { reverted = true; }, async updateLifecycleProgress() {} },
    resolveBackend: () => { throw new Error("backend 'claude' unavailable: claude is not installed"); },
    genRunId: () => "fl-test",
  };
  const res = await runLifecycle("task", "test-lc", { deps, mode: "checkpointed", onCheckpoint: continueCheckpoint });
  strictEqual(res.status, "failed");
  ok(/claude.*not installed/i.test(res.error ?? ""), "actionable backend error surfaced");
  ok(reverted, "todo reverted (not orphaned)");
});

test("spawn receives the merged phase skills + the resolved backend (Q1=B + Q4=C wiring)", async () => {
  // LC with a per-phase claude backend override on phase b + a skill on each phase.
  const LC2 = `---
name: lc-skills
description: t
backend: pi
phases:
  - { name: a, skills: [brainstorming], checkpoint: false }
  - { name: b, skills: [writing-plans], backend: claude, checkpoint: false }
---
## a
pa
## b
pb
`;
  const captured: Array<{ skills: string[]; backend: string }> = [];
  const deps: LifecycleRunDeps = {
    registry: new Map([["lc-skills", parseLifecycleFile(LC2, "/x/lc.md", "builtin")]]),
    agentRegistry: new Map([["general-purpose", { ...agent, skills: ["test-driven-development"] }]]),
    spawn: async (opts) => {
      captured.push({ skills: opts.skills, backend: opts.backend });
      return { status: "completed" as const, finalText: "ok\n\nArtifacts:\n  - path: x.md\n", runId: "fl", todoId: opts.lifecycleTodoId, agent: "general-purpose", model: "m", durationMs: 1, tokenTotal: 0 };
    },
    todoPort: { async linkOrCreateRunTodo() { return { todoId: "td" }; }, async markRunTodoDone() {}, async markRunTodoReverted() {}, async updateLifecycleProgress() {} },
    resolveBackend: (phaseBackend, lifecycleBackend) => phaseBackend ?? lifecycleBackend,
    genRunId: () => "fl-test",
  };
  const res = await runLifecycle("task", "lc-skills", { deps, mode: "auto", onCheckpoint: autoCheckpoint });
  strictEqual(res.status, "completed");
  strictEqual(captured.length, 2);
  // Phase a: merge brainstorming + agent's test-driven-development; backend pi (lifecycle default).
  ok(captured[0]!.skills.includes("brainstorming"), "phase a gets the brainstorming skill");
  ok(captured[0]!.skills.includes("test-driven-development"), "merged with the agent's own skills");
  strictEqual(captured[0]!.backend, "pi", "phase a backend = lifecycle default");
  // Phase b: per-phase backend override claude.
  strictEqual(captured[1]!.backend, "claude", "phase b backend = per-phase override (Q4=C)");
  ok(captured[1]!.skills.includes("writing-plans"), "phase b gets the writing-plans skill");
});


test("SPEC-5a Q3=A: artifactDiscovery hook overrides parseArtifacts when worktreePath is set", async () => {
  const lc = parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")!;
  let i = 0;
  const spawns = [
    { finalText: "phase a output (no Artifacts block)", status: "completed" as const },
    { finalText: "phase b output", status: "completed" as const },
    { finalText: "phase c output", status: "completed" as const },
  ];
  const deps: LifecycleRunDeps = {
    registry: new Map([["test-lc", lc]]),
    agentRegistry: new Map([["general-purpose", agent]]),
    spawn: async (_o) => ({ status: spawns[i]!.status, finalText: spawns[i++]!.finalText, runId: "fl-x", todoId: "td", agent: "general-purpose", model: "m", durationMs: 1, tokenTotal: 0 }),
    todoPort: { async linkOrCreateRunTodo() { return { todoId: "td" }; }, async markRunTodoDone() {}, async markRunTodoReverted() {}, async updateLifecycleProgress() {} } as any,
    resolveBackend: (_p, lb) => lb,
    genRunId: () => "fl-q3a",
    // Q3=A: worktree-diff discovery — returns structural paths, ignoring the (absent) Artifacts block
    artifactDiscovery: ({ finalText, terminal }) => ({ summary: finalText.slice(0, 40), paths: terminal ? [] : ["worktree-out.md"] }),
  };
  const onCheckpoint: CheckpointFn = async () => ({ action: "continue" });
  const res = await runLifecycle("t", "test-lc", { deps, mode: "auto", onCheckpoint, worktreePath: "/tmp/wt", baseRef: "HEAD" });
  strictEqual(res.status, "completed");
  // phases a + b should have the diff-discovered path; phase c is terminal (no paths)
  ok(res.phases[0]!.paths.includes("worktree-out.md"), `phase a paths: ${res.phases[0]!.paths.join(",")}`);
  ok(res.phases[1]!.paths.includes("worktree-out.md"), `phase b paths: ${res.phases[1]!.paths.join(",")}`);
  strictEqual(res.phases[2]!.paths.length, 0);
});

test("SPEC-5a Q3=A: without worktreePath, artifactDiscovery is NOT used (foreground falls back to parseArtifacts)", async () => {
  const lc = parseLifecycleFile(LC_SRC, "/x/test-lc.md", "builtin")!;
  let i = 0;
  const spawns = [
    { finalText: "phase a\n\nArtifacts:\n  - path: a.md\n", status: "completed" as const },
    { finalText: "phase b\n\nArtifacts:\n  - path: b.md\n", status: "completed" as const },
    { finalText: "phase c done", status: "completed" as const },
  ];
  let discoveryCalled = false;
  const deps: LifecycleRunDeps = {
    registry: new Map([["test-lc", lc]]),
    agentRegistry: new Map([["general-purpose", agent]]),
    spawn: async (_o) => ({ status: spawns[i]!.status, finalText: spawns[i++]!.finalText, runId: "fl-x", todoId: "td", agent: "general-purpose", model: "m", durationMs: 1, tokenTotal: 0 }),
    todoPort: { async linkOrCreateRunTodo() { return { todoId: "td" }; }, async markRunTodoDone() {}, async markRunTodoReverted() {}, async updateLifecycleProgress() {} } as any,
    resolveBackend: (_p, lb) => lb,
    genRunId: () => "fl-fg",
    artifactDiscovery: () => { discoveryCalled = true; return { summary: "x", paths: ["should-not-be-used.md"] }; },
  };
  const onCheckpoint: CheckpointFn = async () => ({ action: "continue" });
  // NO worktreePath → foreground path → parseArtifacts used, artifactDiscovery NOT called
  const res = await runLifecycle("t", "test-lc", { deps, mode: "auto", onCheckpoint });
  strictEqual(res.status, "completed");
  strictEqual(discoveryCalled, false);
  strictEqual(res.phases[0]!.paths[0], "a.md");
});
