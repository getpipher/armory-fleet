# SPEC-2 — Deep armory integration

> **Status:** DRAFT (brainstorming output, pre-plan) · **Owner:** RECTOR · **Created:** 2026-07-24
> **Package:** `@getpipher/armory-fleet` · **npm org:** getpipher (account `rz1989`) · **Repo:** `getpipher/armory-fleet`
> **Compatibility:** pi `^0.81.1`
> **Pipeline position:** PRD (done) → SPEC-1 (done, merged) → **SPEC-2 (this)** → spec → plan → implementation → SPEC-3 …
> **Anchors:** Master PRD [`../PRD.md`](../PRD.md) §8 SPEC-2 · SPEC-1 spec [`./SPEC-1-core-engine-todo-sync.md`](./SPEC-1-core-engine-todo-sync.md) · Landscape research [`../research/`](../research/)

---

## 1. Overview & goals

SPEC-2 completes the **child-side moat** (PRD §2: "agents armory-native from birth"). SPEC-1 landed todo-sync; SPEC-2 makes every fleet-spawned subagent **memory-hydrated** and **vision-capable** by default — delivered **deliberately by fleet**, not inherited accidentally from the host.

**In scope (v0.2):**
- A fleet-owned `CustomResourceLoader` that takes deliberate control of the child's extension set, system prompt, and tools (promoting SPEC-1's `DefaultResourceLoader`-with-overrides per SPEC-1 Q8/§12).
- `MemoryHydratePort` + `ArmoryMemoryAdapter` — three-scope memory hydration (project / local / user) into the child's system prompt.
- `VisionPort` + `ArmoryVisionAdapter` — capability-aware `describe_image` injection: text-only child model → fleet injects a delegation tool; multimodal → pass-through, no tool.
- Two companion PRs to the sibling packages (armory-memory, vision) adding `exports` + `index.ts`/`.d.ts` re-exporting the pure functions fleet consumes (same shape as the SPEC-1 armory-todo companion PRs #12/#13).
- Frontmatter additions: `memoryHydrate` (default `true`) + `vision` (default `true`) — the armory-hook toggles, consistent with SPEC-1's `todoSync`.
- Hardened `todo`-exclusion via `excludeTools: ["todo"]` (replaces SPEC-1's fragile active-set omission).
- `systemPromptOverride` composition fix — the child keeps pi's base system prompt (tool docs, guidelines, scoped skills, context files) + gains the role prompt + memory block, instead of SPEC-1's replace-everything-with-rolePrompt.
- Agents-view maturity: an armory-hook chip per agent row + a read-only `i:Info` detail pane (PRD §8 "Agents-view matures to show armory-hooks per agent").
- A real-pi smoke matrix proving the moat is delivered AND the negative space holds (no double-injection, no leaked host-extension context, deterministic child).

**Out of scope (deferred):**
- **cursor** — a TUI editor component; a child SDK session is headless (no editor surface). "Cursor editor in child sessions" (PRD §8) is a category error; cursor lands at **SPEC-5b** (Fleet TUI) where the *fleet panel's* task composer / mid-run steering get the editor. See §12 + decision log Q2.
- Per-agent `memoryHydrate` scope selection and per-agent `vision.model` override — SPEC-5b/SPEC-6 power-knobs.
- Worktree-isolated memory cwd — SPEC-5a (the `MemoryHydratePort` contract is forward-compatible; see §4.1).

**Done bar (v0.2):** A fleet-spawned subagent is memory-hydrated (three scopes) and vision-capable (delegation when text-only, pass-through when multimodal) by default, with `todo` never callable and no host-extension leakage into the child — all delivered by fleet's own loader + ports, deterministically. The full moat (todo + memory + vision) is real and verified in real pi. Cursor remains a recorded SPEC-5b deferral.

**Competitive dimension (PRD §8 SPEC-2):** Moat complete — uncopyable. Nobody else has subagents that are TODO-synced + memory-hydrated + vision-capable by deliberate construction.

---

## 2. Architecture — the `CustomResourceLoader`

### 2.1 The inheritance finding (negative-space guide)

A child session built via `createAgentSession` + `DefaultResourceLoader` (exactly what SPEC-1 ships) **inherits the host's global packages** — `~/.pi/agent/settings.json` `packages` (armory-memory, vision, armory-todo, every installed extension) are re-resolved by the loader's own `DefaultPackageManager` and loaded into the child. So a SPEC-1 child is *accidentally* armory-native: armory-memory's `before_agent_start` injects memory; vision's `syncToolAvailability` adds/removes `describe_image` against the child's model; armory-todo injects the "Open-TODOs" block.

SPEC-2 **rejects accidental inheritance** in favor of **deliberate fleet ownership** (SPEC-1 §9.1 principle: *"vision/cursor/memory hooks get injected into the child deliberately by fleet's loader, not inherited accidentally — same single-writer discipline"*). The inheritance finding is retained as the **negative-space guide**: it tells fleet exactly what the `CustomResourceLoader` must suppress to avoid double-injection and leakage.

### 2.2 Why fleet-owned, not inherited

| Reason | Detail |
|---|---|
| **SPEC-1 §9.1 already decided it** | deliberate-injection over accidental-inheritance is on the books; inheritance contradicts it. |
| **Deterministic children** | Inheritance makes the child's capability set a function of the host's `settings.json` — non-deterministic across environments (laptop vs CI vs end-user). Fleet-owned makes it a function of fleet + agent frontmatter. |
| **No leaks** | Inheritance loads the host's *entire* extension pile — armory-todo's "Open-TODOs" block leaks into the child's prompt; cursor loads and no-ops; arbitrary extensions may misbehave headless. Fleet-owned = exactly rolePrompt + memory + vision-tool, nothing else. |
| **Moat depth** | "Composition by coincidence" is trivially copied; a typed port contract is a deeper integration. The ports-and-adapters **is** the moat's substance. |
| **Contract stability** | A port pins the contract; the adapter absorbs sibling breaking changes. CI typecheck alarms on sibling churn (same as SPEC-1 todo-sync). |
| **Ecosystem coherence** | armory-todo already has `exports` + `.d.ts`. vision/memory getting the same is the consistent getpipher pattern. |

### 2.3 The loader (promotes SPEC-1's `DefaultResourceLoader`-with-overrides)

The child factory constructs a `DefaultResourceLoader` with three deliberate controls SPEC-1 left accidental:

```ts
const loader = new DefaultResourceLoader({
  cwd: parentCwd,
  agentDir: getAgentDir(),
  noExtensions: true,          // (1) suppress ALL host extensions → deterministic child, no double-injection, no Open-TODOs leak
  systemPromptOverride: (base) => composeChildPrompt({   // (2) compose, don't replace
    rolePrompt: agent.rolePrompt,
    memoryBlock: agent.memoryHydrate ? memoryPort.renderScopes({ project: parentCwd, local: parentDir, user: USER_PSEUDO_CWD }) : "",
    base,                       // pi's base: tool snippets, guidelines, context files (AGENTS.md cascade), scoped skills
  }),                          // → rolePrompt + "\n\n" + memoryBlock + "\n\n" + base  (empty memoryBlock omitted)
  skillsOverride: (cur) => ({  // SPEC-1 carry-over: scope skills to the agent's declared set
    skills: agent.skills.length ? cur.skills.filter((s) => agent.skills.includes(s.name)) : cur.skills,
    diagnostics: cur.diagnostics,
  }),
});
await loader.reload();
```

Then the child session (note the hardened `excludeTools` + conditional `customTools`):

```ts
const { session } = await createAgentSession({
  cwd: parentCwd,
  model,
  thinkingLevel: agent.thinkingLevel,
  tools: childTools,                              // built-ins (agent.tools ?? ["read","bash","edit","write"])
  excludeTools: ["todo"],                         // (3) hardened single-writer guard (replaces SPEC-1 active-set omission)
  customTools: (agent.vision && !visionPort.isMultimodal(model)) ? [fleetDescribeImageTool] : [],
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});
```

### 2.4 The `systemPromptOverride` composition (SPEC-1 remediation)

SPEC-1's override was `() => rolePrompt` — it **discarded** pi's base system prompt, so the child lost tool snippets, guidelines, context files, and — critically — the **scoped skills' prompt contributions** (which SPEC-1 went to the trouble of shaping via `skillsOverride`). SPEC-2 changes the override to `(base) => rolePrompt + "\n\n" + memoryBlock + "\n\n" + base`, composing the persona + memory on top of pi's base. The child now gets the full framework prompt + its persona + its project/workspace/user memory. The `base` argument is the value the loader would have used (resource-loader.js: `systemPrompt = override ? override(baseSystemPrompt) : baseSystemPrompt`); fleet forwards it instead of ignoring it.

**Prompt order:** `rolePrompt → memoryBlock → base`. Persona first (standard), memory next (project context salient to the task), pi's base last (tool/guideline framework). The order is tunable; this is the v0.2 default.

---

## 3. Components (file layout — additions/changes vs SPEC-1)

```
src/
  memory-hydrate/
    port.ts                 # MemoryHydratePort interface (fleet-owned)
    adapter.ts              # ArmoryMemoryAdapter — only file importing @getpipher/armory-memory
  vision/
    port.ts                 # VisionPort interface (fleet-owned)
    adapter.ts              # ArmoryVisionAdapter — only file importing @getpipher/vision
    describe-image-tool.ts  # the fleet-defined describe_image tool (thin wrapper over VisionPort.delegate)
  engine/
    spawnSubagent.ts        # MODIFIED: pass memoryPort/visionPort to the child factory; excludeTools hardening
    child-loader.ts         # NEW: the CustomResourceLoader builder (noExtensions + compose + skills)
  registry/
    frontmatter.ts          # MODIFIED: add memoryHydrate + vision fields (bool, default true)
  panel/
    fleet-panel.ts          # MODIFIED: Agents-view armory chip + i:Info detail pane
    rows.ts                 # MODIFIED: armory-chip row fn + info-pane content fn
  index.ts                  # MODIFIED: wire ArmoryMemoryAdapter + ArmoryVisionAdapter into deps; pass to factory
agents/
  general-purpose.md        # MODIFIED: explicit memoryHydrate: true + vision: true
```

---

## 4. Memory hydration — port + adapter

### 4.1 The port (fleet-owned)

```ts
// src/memory-hydrate/port.ts
export interface MemoryScopes {
  project: string;   // cwd — the project the child works in (= parentCwd in SPEC-2)
  local: string;     // parent-directory / workspace cwd (the org level, e.g. ~/local-dev/getpipher)
  user: string;      // a fixed global pseudo-cwd for cross-project user memory (e.g. USER_PSEUDO_CWD)
}

export interface MemoryHydratePort {
  /** Render the three-scope memory block (project → local → user), concatenated. Empty scopes contribute nothing. */
  renderScopes(scopes: MemoryScopes): string;
}
```

**Forward-compat (recorded, not built):** the port takes explicit scope cwds, not an implicit "the child's cwd." In SPEC-2 `project = parentCwd`. At SPEC-5a (worktree isolation) the child's cwd becomes a worktree but `project` stays the parent project's cwd — so the subagent hydrates the *project's* memory even when isolated. The contract is stable across SPECs; only the caller's choice of `project` changes.

### 4.2 The adapter (only armory-memory importer)

```ts
// src/memory-hydrate/adapter.ts
import { renderMemoryBlock, listMemory } from "@getpipher/armory-memory";
export class ArmoryMemoryAdapter implements MemoryHydratePort {
  renderScopes(scopes: MemoryScopes): string {
    return [scopes.project, scopes.local, scopes.user]
      .filter((cwd) => listMemory(cwd).length > 0)   // skip empty scopes cleanly (no placeholder to render)
      .map((cwd) => renderMemoryBlock(cwd))          // armory-memory's existing cwd-keyed primitive
      .join("\n\n");                                // → "" when all three scopes are empty
  }
}
```

armory-memory needs **no new scope logic** — the three-tier scope is fleet-owned composition over armory-memory's cwd-keyed primitive. The companion PR to armory-memory is just the `exports` map + `index.ts`/`.d.ts` re-exporting `renderMemoryBlock`, `listMemory`, `memoryDirFor`, `toSlug` (same shape as armory-todo #12/#13).

### 4.3 The three scopes (PRD §8 interpretation)

The PRD says "scoped per project/local/user" without defining the terms. SPEC-2 interprets them by mirroring pi's own context-file cascade (project → parent dirs → global `~/.pi/agent/`):

| Scope | Means | Memory dir | Delivered by |
|---|---|---|---|
| **project** | the cwd the child works in | `~/.pi/agent/memory/<cwd-slug>/` (armory-memory's existing dir) | armory-memory as-is |
| **local** | the **immediate parent directory** of the project cwd (the workspace/org level — e.g. for cwd `~/local-dev/getpither/armory-fleet`, `local` = `~/local-dev/getpither`) | `~/.pi/agent/memory/<parent-slug>/` | fleet calls `renderMemoryBlock(dirname(projectCwd))` |
| **user** | global, cross-project user memory | a fixed pseudo-cwd dir (e.g. `~/.pi/agent/memory/_user/`) | fleet calls `renderMemoryBlock(USER_PSEUDO_CWD)` |

`USER_PSEUDO_CWD` is a fleet-defined constant (e.g. `"/__armory-fleet-user__"`) whose slug resolves to a stable global memory dir. The value is a fleet concern, not an armory-memory concern.

---

## 5. Vision — port + adapter + the fleet `describe_image` tool

### 5.1 The port (fleet-owned)

```ts
// src/vision/port.ts
import type { Model } from "@earendil-works/pi-ai";
export interface VisionPort {
  isMultimodal(model: Model<any> | undefined): boolean;
  delegate(params: { image: string; prompt?: string }): Promise<string>;  // delegates to the configured vision model
  loadConfig(): { provider?: string; model?: string } | null;              // reads the host vision.json
}
```

### 5.2 The adapter (only vision importer)

```ts
// src/vision/adapter.ts
import { isMultimodal, delegateToVisionModel, loadConfig } from "@getpipher/vision";
export class ArmoryVisionAdapter implements VisionPort { /* … */ }
```

The adapter reads the **host's `vision.json`** (the config the user set via the host `/vision` panel) — "armory-native from birth" = inherit the host's configured vision model. If no vision model is configured, `delegate(...)` returns an actionable error: *"no vision model configured; run `/vision model <id>` in the host or set `vision: false` on this agent."* Per-agent `vision.model` override is deferred (SPEC-5b power-knob).

The companion PR to vision: `exports` + `index.ts`/`.d.ts` re-exporting `isMultimodal` (from `lib/capability.ts`), `delegateToVisionModel` (from `lib/delegate.ts`), `loadConfig` (from `lib/config.ts`), and the `VisionConfig` type.

### 5.3 The fleet `describe_image` tool (injected into the child, text-only only)

```ts
// src/vision/describe-image-tool.ts
// A fleet-defined tool whose execute() calls visionPort.delegate(...).
// Registered into the child via createAgentSession's customTools (text-only child + agent.vision only).
```

The child's `describe_image` is **fleet-defined**, not vision's own extension tool — vision's extension never loads into the child (`noExtensions: true`). The tool's `execute()` calls `visionPort.delegate({ image, prompt })` and returns the text description. The model-callable surface mirrors vision's own `describe_image` contract (path/image input, optional prompt) so user muscle memory transfers.

### 5.4 Capability-aware rule (applied to the CHILD's model)

- `agent.vision === false` → never inject `describe_image` (opt-out).
- child model multimodal (`visionPort.isMultimodal(model)`) → **no `describe_image`**; the child's own `read` tool produces image attachments that pass through natively to the child model. Zero delegation, zero extra tokens — the vision thesis, applied to the child.
- child model text-only → inject the fleet `describe_image` via `customTools`; the child calls it when it `read`s an image file.

**Image path into the child (v0.2):** the child's own `read` tool (built-in) is the only image path. Path-referenced images in the task *string* are NOT auto-attached (that's the host vision extension's paste-hook job; out of scope for headless children). A parent can instruct "read ./img.png" and the child's `read` tool handles it.

### 5.5 Impl-verification flag (mechanical, not architectural)

To be confirmed at plan/impl time: **how to inject the fleet `describe_image` custom tool into a child session under `noExtensions: true`.** Two viable paths: (a) `createAgentSession` accepts a `customTools`/`extensionFactories` option that loads even with `noExtensions`, or (b) fleet ships a tiny internal extension via `extensionFactories` that registers the tool. Both achieve the same design goal. Resolve against the SDK source (`dist/core/sdk.js`, `dist/core/resource-loader.js`) when writing the plan.

---

## 6. Frontmatter schema additions

SPEC-1 §7.2 deferred `memoryHydrate`/`vision`/`cursor`. SPEC-2 lands two; cursor stays deferred. Consistent with the SPEC-1 precedent: **named field, default-on, toggleable — the moat as a visible contract.**

| Field | v0.2 | Default | Notes |
|---|---|---|---|
| `todoSync` | ✅ (SPEC-1) | `true` | link/track runs in armory-todo |
| `memoryHydrate` | ✅ **NEW** | `true` | hydrate three-scope memory (project/local/user) into the child's system prompt; `false` = opt-out (throwaway delegate) |
| `vision` | ✅ **NEW** | `true` | capability-aware: inject `describe_image` when child model text-only; pass-through when multimodal; `false` = never inject |
| `cursor` | ❌ | — | deferred to SPEC-5b (Fleet TUI) |

**Shape: bool, not rich object** — consistent with `todoSync`. Per-agent scope selection (`memoryHydrate: { scopes: [...] }`) and per-agent `vision.model` override are deferred to SPEC-5b/SPEC-6 power-knobs.

### 6.1 The `general-purpose` builtin (grown)

```md
---
name: general-purpose
description: A focused general-purpose subagent delegate. Use for any task needing isolated work.
todoSync: true
memoryHydrate: true
vision: true
---
You are a focused subagent delegate. Complete the assigned task thoroughly, work
autonomously to completion, and return a concise result summary. Do not call the
`todo` tool — the fleet engine manages todo tracking for you.
```

---

## 7. The spawn lifecycle — what changes from SPEC-1 §5

SPEC-1's 8-step lifecycle is unchanged in shape; SPEC-2 modifies step 4 (child session construction) and adds the port wiring. Delta:

- **Step 2 (Engine — resolve model/tools):** model resolution unchanged. Tool computation now: `tools = (agent.tools ?? PI_DEFAULT_TOOLS)`; the `todo`-exclusion moves from `baseTools.filter(...)` to `excludeTools: ["todo"]` on `createAgentSession`. `customTools = (agent.vision && !visionPort.isMultimodal(model)) ? [fleetDescribeImageTool] : []`.
- **Step 4 (Child session):** the `DefaultResourceLoader` is built per §2.3 (`noExtensions: true`, composed `systemPromptOverride`, `skillsOverride`). `memoryPort` + `visionPort` are threaded into the child factory (new deps on `SpawnOptions`/`ChildSessionOpts`).
- **Steps 1, 3, 5–8:** unchanged (todo-sync lifecycle, run registry, Esc-abort, turn budget, dispose). Memory/vision are child-construction concerns; they don't touch the run↔todo link.

`memoryHydrate: false` → the `systemPromptOverride` skips the `memoryPort.renderScopes` call (empty memoryBlock, omitted from composition). `vision: false` → `customTools` is empty regardless of model modality.

---

## 8. The `/fleet` panel — Agents-view maturity

### 8.1 Agents-view row (armory chip)

SPEC-1 §8.2 row grows an **armory chip** showing the three hooks' state per agent:

```
reviewer · [project] · anthropic/claude-sonnet-4 · tools:4 · skills:2 · armory:[t✓ m✓ v✓]
throwaway · [global] · ollama/qwen3 · tools:4 · skills:0 · armory:[t✓ m✗ v✗]
```

`t`=todoSync, `m`=memoryHydrate, `v`=vision. Compact to respect panel width.

### 8.2 `i:Info` action (read-only detail pane)

New action on the Agents submenu: `i:Info` opens a read-only detail pane showing the full parsed frontmatter (all hooks, model, thinkingLevel, tools, skills, role-prompt preview). Useful for inspecting an agent's armory-hooks without leaving the panel. SPEC-1's `r/e/d/q` actions unchanged.

### 8.3 Action submenu (Agents, updated)

| View / row | Actions |
|---|---|
| Agents | `r` Run · `e` Edit · `i` Info (detail pane) · `d` Reload · `q` Quit |

The Fleet-view submenu is unchanged from SPEC-1 §8.3.

---

## 9. Guards (SPEC-1 §9 generalized + hardened)

### 9.1 `todo` excluded from child tools — HARDENED
SPEC-1 excluded `todo` by omitting it from the `tools` active-set — fragile (relies on armory-todo never calling `setActiveTools`). SPEC-2 hardens it: `excludeTools: ["todo"]` on `createAgentSession` (sdk.js applies `excludeTools` after any `tools` allowlist). Defense-in-depth: with `noExtensions: true`, armory-todo's extension doesn't load into the child at all, so `todo` is never registered — the `excludeTools` is a belt-and-suspenders guard against any future tool named `todo`.

### 9.2 Single-writer discipline — generalized + enforced
SPEC-1 §9.1 stated the principle ("vision/cursor/memory hooks injected deliberately by fleet's loader, not inherited accidentally"). SPEC-2 enforces it structurally: `noExtensions: true` means **no host extension hooks fire in the child**; fleet is the sole injector of memory (via `systemPromptOverride`) and vision (via `customTools`). No accidental inheritance is possible.

### 9.3 Concurrency=1, turn budget, Esc-abort — unchanged from SPEC-1 §9.

---

## 10. Error handling

Every failure is actionable and specific (CIPHER constraints). New SPEC-2 failure modes:

- **No vision model configured** (text-only child, `vision: true`, host has no `vision.json` model) → the child's `describe_image` returns: *"no vision model configured; run `/vision model <id>` in the host or set `vision: false` on this agent."* The run is not failed — the child can proceed without image analysis; the error surfaces per-call.
- **armory-memory not installed** (the `ArmoryMemoryAdapter` import resolves to nothing) → fleet fails fast at extension load with an actionable notify: *"armory-memory not found; install `@getpipher/armory-memory` or set `memoryHydrate: false` on all agents."* (Or, if the port is optional, memory hydration silently no-ops — decide at plan time; lean: fail-fast, the moat is a contract.)
- **vision not installed** (text-only child, `vision: true`) → same fail-fast pattern: *"vision not found; install `@getpipher/vision` or set `vision: false`."*
- **systemPromptOverride composition error** → the override must never crash the child; wrap in try/catch, fall back to `base` only (memory omitted), notify.

The SPEC-1 error modes (unknown agent, linked todo not found, child provider error, turn-budget, concurrency-busy) are unchanged.

---

## 11. Testing

`node:test` via tsx (getpipher convention; runner = `node --import tsx --test test/*.test.mts`). Target 80%+ on new code.

### 11.1 Unit (mocks)

- `MemoryHydratePort` + `ArmoryMemoryAdapter` — `renderScopes` composes three `renderMemoryBlock` calls in order (project → local → user); empty-scope placeholders dropped; correct concatenation; the adapter is the only `@getpipher/armory-memory` importer.
- `VisionPort` + `ArmoryVisionAdapter` — `isMultimodal` delegates to vision's fn; `delegate` calls `delegateToVisionModel` with host config; `loadConfig` reads `vision.json`; actionable error when no vision model configured.
- `describe-image-tool.ts` — the fleet tool's `execute()` calls `visionPort.delegate(...)` and returns the text; param validation (image required).
- `child-loader.ts` — `noExtensions: true` passed; `systemPromptOverride` composes `rolePrompt + memoryBlock + base` in order, omits empty memoryBlock; `memoryHydrate:false` skips the memory call; `skillsOverride` scopes per agent; `excludeTools: ["todo"]` passed; `customTools` includes `describe_image` only when `vision:true && !isMultimodal(model)`.
- frontmatter parser — `memoryHydrate`/`vision` parsed, default `true`, bool validation, malformed → skip+warn (SPEC-1 §7.1 carry-over).
- panel rows — armory chip renders correct ✓/✗ per hook; `i:Info` detail pane content.

### 11.2 Real-pi smoke matrix (`term`-driven; the EditorTheme-gotcha lesson)

| # | Setup | Assert |
|---|---|---|
| 1 | text-only child model, default agent | `describe_image` tool present; system prompt contains three-scope memory block; `todo` tool absent; **no "Open-TODOs" block leaked**; no host extension hooks fired |
| 2 | multimodal child model, default agent | `describe_image` absent (pass-through); memory block present; `todo` absent |
| 3 | `memoryHydrate: false` agent | no memory block in child prompt |
| 4 | `vision: false` agent, text-only model | no `describe_image` injected |
| 5 | any agent | child prompt contains pi base (tool docs/guidelines/scoped skills) — confirms `systemPromptOverride` composes, doesn't replace |

This is the "verify the moat is real" work AND the negative-space proof (no double-injection, no leaked host-extension context, deterministic child capability set).

---

## 12. Deferred (recorded, with landing SPEC)

| Deferral | Landing SPEC | Why deferred |
|---|---|---|
| **cursor** frontmatter field + `CursorPort` + cursor-in-fleet-panel | SPEC-5b | cursor is a TUI editor; child SDK sessions are headless. "Cursor editor in child sessions" (PRD §8) is a category error; cursor belongs in the fleet panel's task composer / mid-run steering (Fleet TUI). |
| Per-agent `memoryHydrate` scope selection (`{ scopes: [...] }`) | SPEC-5b/SPEC-6 | power-knob; bool default-on is the v0.2 moat |
| Per-agent `vision.model` override | SPEC-5b | power-knob; reuse host vision.json is the v0.2 default |
| Worktree-isolated memory cwd (`project` ≠ parentCwd) | SPEC-5a | the `MemoryHydratePort` contract is already forward-compatible (explicit scope cwds) |
| Path-referenced image auto-attachment in task string (vision paste-hook for children) | SPEC-5b | the child's `read` tool is the only image path in v0.2 |
| `get_run_result` / async / background / scheduling | SPEC-5a | foreground synchronous in v0.1/v0.2 |
| Conversation viewer / live widget / mid-run steering | SPEC-5b | transcripts ephemeral |
| Cross-harness `backend` (`pi\|claude`) | SPEC-3 | dual-arsenal |

Nothing is silently dropped; every deferral is recorded with its landing SPEC. The PRD §8 "cursor editor in child sessions" wording is reconciled here (decision log Q2) — same flavor as the SPEC-4 "role-per-phase" flag SPEC-1 §7.3 recorded.

---

## 13. Done bar / success criteria (v0.2)

- ✅ A fleet-spawned subagent is **memory-hydrated** by default (three-scope: project/local/user) via `MemoryHydratePort` + `ArmoryMemoryAdapter`; the memory block is composed into the child's system prompt alongside pi's base + the role prompt.
- ✅ A fleet-spawned subagent is **vision-capable** by default: text-only child model → fleet `describe_image` injected (delegates to the host's configured vision model); multimodal child model → pass-through, no tool.
- ✅ `todo` is **never callable** in a child (hardened `excludeTools: ["todo"]` + `noExtensions: true` belt-and-suspenders).
- ✅ **No host-extension leakage** into the child — no "Open-TODOs" block, no cursor no-op, no arbitrary extension hooks; the child is a deterministic delegate.
- ✅ `memoryHydrate: false` + `vision: false` opt-outs work per agent; frontmatter fields default `true`.
- ✅ Agents-view shows the armory chip per agent + `i:Info` detail pane.
- ✅ Companion PRs to armory-memory + vision (exports + `.d.ts`) merged; fleet core depends only on the ports.
- ✅ `pnpm typecheck` + `pnpm test:run` green; the 5-row real-pi smoke matrix passes.
- ✅ The full moat (todo + memory + vision) is real and verified.

**Competitive dimension (PRD §8 SPEC-2):** Moat complete — uncopyable.

---

## 14. Decision log (brainstorm)

| Q | Decision |
|---|---|
| Q1 (mechanism) | **Ports-and-adapters, fleet-owned** for memory + vision (cursor deferred). Mirrors SPEC-1 todo-sync; fleet owns `*Port`, `Armory*Adapter` is sole importer; companion PR per sibling (`exports` + `.d.ts`). |
| (inheritance finding) | A SPEC-1 child accidentally inherits host global packages via `DefaultResourceLoader`'s `DefaultPackageManager` reading `~/.pi/agent/settings.json`. SPEC-2 **rejects** accidental inheritance (contradicts SPEC-1 §9.1; non-deterministic; leaky; weaker moat) and retains the finding as the negative-space guide for what `noExtensions` must suppress. |
| Q2 (cursor) | **Deferred to SPEC-5b.** Cursor is a TUI editor (`CursorEditor extends CustomEditor`); child SDK sessions are headless — "cursor editor in child sessions" (PRD §8) is a category error. Cursor belongs in the fleet panel's task composer / mid-run steering (Fleet TUI). PRD §8 wording reconciled (§12). |
| Q3 (vision mechanism) | Capability check targets the **child's own model**. Multimodal → no `describe_image` (pass-through via the child's `read` tool). Text-only → fleet injects a `describe_image` (via `VisionPort.delegate`). Image path in v0.2 = the child's `read` tool only (no task-string auto-attach). |
| Q4 (memory scope) | PRD §8 sets three scopes (project/local/user). Interpretation: **project = cwd · local = parent-dir/workspace · user = global cross-project**, mirroring pi's context-file cascade. Fleet composes three `renderMemoryBlock` calls; armory-memory unchanged (cwd-keyed primitive). |
| Q5 (vision delegation config) | **Reuse the host's `vision.json`** (PRD §8 "delegate-to-vision" implies the configured vision model). Per-agent `vision.model` override deferred to SPEC-5b. Fleet-specific config rejected (invents surface the PRD doesn't imply). |
| (loader) | `CustomResourceLoader` = `DefaultResourceLoader` with `noExtensions: true` + composed `systemPromptOverride` + `skillsOverride`; child session uses `excludeTools: ["todo"]` + conditional `customTools`. |
| (systemPromptOverride) | Compose `(base) => rolePrompt + memoryBlock + base` (remediates SPEC-1's replace-everything, which discarded pi's base + scoped-skill contributions). |
| (frontmatter shape) | `memoryHydrate` + `vision` are **bool, default `true`** — consistent with `todoSync`. Rich object/scope-selection deferred to SPEC-5b/SPEC-6. |
| (todo-exclusion hardening) | `excludeTools: ["todo"]` replaces SPEC-1's active-set omission (fragile). Belt-and-suspenders with `noExtensions: true`. |
| (impl flag) | Verify at plan time how `customTools`/`extensionFactories` inject the fleet `describe_image` under `noExtensions: true` (§5.5). |

---

## 15. References

- Master PRD: [`../PRD.md`](../PRD.md) §2 (moat), §8 SPEC-2 scope
- SPEC-1 spec: [`./SPEC-1-core-engine-todo-sync.md`](./SPEC-1-core-engine-todo-sync.md) §5 (spawn lifecycle), §7.2 (frontmatter + deferred fields), §9.1 (single-writer discipline), §12 (deferrals)
- pi SDK doc: `…/pi-coding-agent/docs/sdk.md` (`createAgentSession`, `tools`/`excludeTools`/`customTools`, `DefaultResourceLoader`, `systemPromptOverride`)
- pi extensions doc: `…/pi-coding-agent/docs/extensions.md` (`before_agent_start`, `setActiveTools`)
- Sibling sources: `~/local-dev/getpipher/armory-memory/src/memory-store.ts` (`renderMemoryBlock`), `~/local-dev/getpipher/vision/lib/{capability,delegate,config}.ts`
- getpither conventions + EditorTheme gotcha: `~/local-dev/getpipher/AGENTS.md`
- SPEC-1 companion PRs (the pattern): armory-todo #12 (`exports` + `index.ts`) + #13 (`index.d.ts` + dual-condition exports)