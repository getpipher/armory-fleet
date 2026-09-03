# armory-gateway SPEC-1b-2 — Fleet Governance Adapter (lean & live)

> **Status:** 🧠 Design (brainstormed 2026-08-30, RECTOR-approved via 5 scope gates). Next gate: RECTOR spec review → writing-plans (plan-phase verification V1–V4 BEFORE freeze) → SDD.
> **Parent:** `SPEC-1b-armory-native-moat.md` §16 (names this slice) + `SPEC-1-design.md` §5 integration model, §10.3 (open question this slice resolves).
> **Changing repo:** `@getpipher/armory-fleet` (v1.2.0, main @ `aa0dbef`) — **this slice is a pure fleet PR; zero gateway code changes.** Consumed surface: `@getpipher/armory-gateway` main @ `410a22c` (unpublished/private; registration API + contract types exported from its index).
> **Relocation:** spec stages here; moves into **fleet's** `docs/` at PR time (with as-built notes). Gateway's progress table gets a pointer line.
> **Process:** identical to prior slices — brainstorm gates ✅ → this spec → writing-plans → SDD (fresh implementer/reviewer per task, final whole-branch review on session model) → PR → `--merge --delete-branch`.

---

## 1. Goal & scope

Register armory-fleet as the **first live governance provider** against armory-gateway's 1b IoC contract: fleet's extension boots in the parent pi process, registers a `registerGovernanceProvider` implementation backed by a settings-driven deny-list, and fleet's pi dependency line aligns with the gateway suite floor (`^0.84.4`). With gateway absent (the public-npm reality for fleet), behavior is byte-identical to fleet v1.2.0 — silent skip, no registration, standalone degradation.

This slice **reverses one premise of SPEC-1b §16** (see §3: ARMORY_* env emission is architecturally dead — deferred with rationale, not dropped silently) and **resolves SPEC-1 §10.3** (fleet pi-version alignment).

| # | Deliverable | Source |
|---|---|---|
| D1 | pi `^0.84.4` alignment (fleet deps bump + gate green) | Q2, SPEC-1 §10.3 |
| D2 | `mcpDeny` settings field (additive, validated, global+project) | Q1, Q5a/b |
| D3 | Pure policy matcher (`src/governance/mcp-policy.ts`) | Q5a |
| D4 | Gateway adapter + boot registration (guarded dynamic import, per-call settings read) — wired in the `session_start` handler, reusing the existing `FleetSettingsStore` | Q1, Q3, Q5c |
| D5 | Fleet README governance section + deferral rationale one-liner | Q1, Q4 |

**Out of scope (deliberate, named — do not flag as missing):** ARMORY_AGENT_ID/ARMORY_TASK_ID env emission (§15.1 — no live reader); per-call cost sink (§15.2 — no fleet accounting home); per-agent/per-run policy scoping (§15.3 — needs concurrency-safe context story); wildcard patterns in `mcpDeny`; mesh-auth; child MCP access (noExtensions stays); any gateway repo change; typebox bump (unless V2/V3 surfaces skew); dependencies→peerDependencies placement change.

## 2. Locked decisions (brainstorm 2026-08-30 — do not re-litigate)

| Q | Decision |
|---|---|
| Q1 slice shape | **A — lean & live**: version alignment + boot-time governance registration (parent process) + minimal settings-driven deny-list. ARMORY_* emission deferred (§15.1). No speculative policy surface (GateRegistry confirmed lifecycle-only). |
| Q2 version strategy | **A — bump to `^0.84.4`**: fleet's three `@earendil-works/*` deps `^0.81.1` → `^0.84.4` in **dependencies, placement unchanged**. Broadening ranges rejected (two test matrices, ratifies skew). Peer placement = own follow-up slice (depends on pi package-manager peer semantics). Folded: typebox `^1.1.38` untouched unless verification flags skew; no in-PR package version bump (release-time `v*` tag per getpipher convention). |
| Q3 package linkage | **A — guarded dynamic import + dev `file:` link + optional-peer-later**: extension boot does `try { const gw = await import("@getpipher/armory-gateway"); gw.registerGovernanceProvider(provider) } catch { /* absent → standalone */ }`. Dev/contract tests use a `file:` devDependency link into the fleet repo (never published as resolvable). When gateway graduates and publishes, fleet adds it as optional peer and the try/catch becomes belt-and-suspenders. Symbol.for direct-store write **rejected** (bypasses the typed seam, forks an undocumented runtime ABI). |
| Q4 sink scope | **A — governance only.** Cost sink = named follow-up gated on fleet growing an accounting home for MCP context-cost (§15.2). SPEC-1 §5's CostMeter→fleet mapping stays aspirational until then. |
| Q5a entry forms | **A — two exact forms**: bare `server` (deny whole server) or `server__tool` (deny one tool). No globs. `server__*` is INVALID (warn+drop). |
| Q5b invalid entries | **A — store precedent**: per-entry validation; invalid entry → actionable warning + drop; valid entries stay enforced. Rationale: `FleetSettingsStore` already established warn-and-drop for bad values (actionable warnings ARE the TierStore-lesson mitigation); shape errors are operator mistakes, not runtime attacks. Gateway's throw→deny fail-closed still guards provider *runtime* failures. Strict deny-all-on-typo rejected (new semantic, turns a typo into full MCP outage). |
| Q5c freshness | **Per-call fresh read**: the provider reads settings on every governed call (two small `readFileSync` — negligible vs MCP call latency). Policy edits take effect immediately, matching the contract's live-lookup philosophy. Boot snapshot rejected (stale security control). |

## 3. Architecture findings (2026-08-30 survey — the evidence behind Q1/Q4)

These findings reverse SPEC-1b premises and are recorded here as the durable rationale:

1. **Fleet's pi children are in-process SDK sessions, not processes.** `createChildSessionFactory` (`src/index.ts`) builds each child with `createAgentSession()` from fleet's own `@earendil-works/pi-coding-agent` copy — same process as the parent. Only claude-backend children are real processes (`claude-factory.ts`), and they run the `claude` CLI, not pi extensions.
2. **`noExtensions: true`** (`src/engine/child-loader.ts:83`) — children load NO extensions: deterministic child, no host-extension leakage. Consequences: (a) gateway never loads in fleet children → children have no MCP tools → **all MCP calls originate in the parent/orchestrator session**; (b) setting `process.env.ARMORY_*` per-spawn would mutate shared parent-process env — racy across concurrent children and would leak scoping into the parent's own gateway calls.
3. **Therefore env-var threading (gateway SPEC-1b §4) has no live reader on any fleet code path** — parent calls are legitimately unscoped (`agent`/`task` = `undefined`, which the contract treats as "no scoping context"); children can neither call MCP nor read env. Emission is deferred, not dead-plain (§15.1 names the revival conditions).
4. **GateRegistry gates are lifecycle-phase constructs** (`GateCtx` = `{phaseRec, spawnRes, lifecycle, …}`) — no per-call policy surface exists in fleet. The adapter's deny-list is the minimal honest policy; a richer per-call policy surface waits for a consumer (YAGNI).
5. **Two SDK copies are structural, not a bug to fix here.** The host runtime (globally installed pi) is never a package dep; fleet's `dependencies` copy resolves separately regardless. Alignment (D1) buys behavioral-skew reduction — above all `SessionManager` file-format compat for resume, since fleet's copy `SessionManager.open()`s files written by the host's copy.
6. **Symbol-store convergence makes the cross-repo import safe under duplicate copies.** Fleet's `import("@getpipher/armory-gateway")` may resolve to a different module instance than the gateway extension's own (dev `file:` link vs the live extension install); `registerGovernanceProvider` writes `globalThis[Symbol.for("@getpipher/armory-gateway:registry")]` — one runtime store regardless (gateway 1b plan-phase V2 proved convergence; fleet contract tests re-pin it).

## 4. D1 — Version alignment

- `package.json` dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` → `^0.84.4` (matching installed runtime 0.84.4 and gateway's dev floor).
- Placement, peer map (`{}`), and all other deps unchanged. `typebox ^1.1.38` unchanged unless V2/V3 flags skew.
- No `version` bump in the PR (release-time `v*` tag; CI publish per getpipher convention).
- Risk carrier: the 0.81→0.84 jump. V2 (§12) gates the plan on the full fleet suite + gates being green post-bump; any breakage triages as fix-in-slice vs named follow-up — NOT silently pinned around.

## 5. D2 — `mcpDeny` settings field (`src/settings/fleet-settings.ts`)

```ts
export interface FleetSettings {
  defaultSubagentThinking?: ThinkingLevel;   // existing (#78)
  /** SPEC-1b-2: MCP governance deny-list. Entries are bare server names (deny the whole
   *  server) or `server__tool` (deny one exact tool). Invalid entries warn + drop. */
  mcpDeny?: string[];
}
```

- Parse (inside `parseFleetSettings`): absent → `undefined` (normal). Present → must be an array of strings; each entry validated: non-empty, and either contains no `__` (bare server) or contains `__` with non-empty server AND non-empty tool parts (`server__tool`). Invalid entries → actionable warning (`<label>: mcpDeny entry <json> is invalid — expected "server" or "server__tool" — dropped`) and dropped; valid entries kept. `mcpDeny` present but not an array → warning + field dropped (same shape as `defaultSubagentThinking`'s handling).
- `known` set gains `"mcpDeny"` (unknown-key warning stays accurate).
- Global+project precedence: project wins per-field (existing spread — no change).
- Warnings surface through the existing `FleetSettingsResult.warnings` plumbing (whatever renders settings warnings today renders these — no new display surface in this slice).

## 6. D3 — Pure policy matcher (`src/governance/mcp-policy.ts` — new)

```ts
export interface McpPolicyTarget { server: string; tool: string; }
export type McpPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

/** Total function — cannot throw. Entries are validated at parse time (D2); the matcher
 *  performs exact-match lookups only and never parses entries at match time. */
export function evaluateMcpPolicy(deny: readonly string[] | undefined, target: McpPolicyTarget): McpPolicyDecision;
```

- Match rule (exact lookups, no entry parsing): `deny.includes(target.server) || deny.includes(\`${target.server}__${target.tool}\`)`.
- Deny reason names the matched entry: `denied by armory-fleet mcpDeny policy: matched "<entry>"`.
- No match / absent / empty list → `{ decision: "allow" }`.

## 7. D4 — Gateway adapter + boot registration (`src/governance/gateway-adapter.ts` — new)

```ts
export interface GatewayAdapterDeps {
  loadDenyList: () => string[] | undefined;                    // fresh per call (Q5c)
  importGateway: () => Promise<GatewayModuleLike>;             // injectable for tests
}
export interface GatewayModuleLike {
  registerGovernanceProvider(fn: GovernanceProviderLike): void;
}
```

- `registerMcpGovernance(deps)`: awaits `importGateway()`; on success registers one provider closure; on failure returns `{ registered: false }` (silent — public-npm normal state; gateway's `status` interceptor line is the observability surface, README documents it).
- Provider closure (the `GovernanceProvider` impl): `evaluateMcpPolicy(deps.loadDenyList(), input)` — note `input.args` is ignored (policy is identity-based, not args-based; args never leave the gateway process boundary into policy code — no new content-handling surface).
- `loadDenyList` wiring: a `FleetSettingsStore` (global `~/.pi/agent/fleet/settings.json` + project `<cwd>/.pi/fleet/settings.json`, same construction as existing wiring) → `store.load().settings.mcpDeny`. Store construction reuses the existing instance/pattern in `src/index.ts` (V4 resolves which). ENOENT/invalid handling is entirely D2/store-owned; `load()` cannot throw for the provider's normal paths.
- **Boot wiring** (`src/index.ts` default export, after deps construction): call `registerMcpGovernance` inside the guarded dynamic import (Q3) — `try { await import("@getpipher/armory-gateway") → register } catch { skip }`. The import specifier is exactly `"@getpipher/armory-gateway"` (resolves via exports map to raw `.ts`; jiti-compatible — gateway 1b V1).
- No gateway import at module top level — the specifier must never appear in static imports (would break public installs at link time).

## 8. D5 — Docs

- Fleet README: new "MCP governance" section — what registers when gateway is present; `mcpDeny` field reference (forms, examples, precedence, warn-and-drop); optional-dependency story (absent gateway = standalone, how to link for dev); one-line deferral note pointing at this spec's §15.
- No README claims beyond wired behavior (getpipher no-oversell rule).

## 9. Error-handling map

| Path | Behavior | Rationale |
|---|---|---|
| Gateway module absent at boot | Silent skip, no registration | Public-npm normal state; status line + README are the observability |
| Settings file absent (ENOENT) | Empty settings → `mcpDeny` undefined → allow-all | Store semantics: absent files are normal |
| Settings unreadable (EACCES…) / invalid JSON | Actionable warning, field dropped → allow-all + warning surfaces | Existing store semantics; operator sees the warning |
| `mcpDeny` entry invalid | Per-entry warn + drop; valid entries enforced | Q5b — store precedent |
| Provider runtime throw (unforeseen) | Gateway converts to structured deny | Gateway-side fail-closed (SPEC-1b §4) — untouched backstop |
| Fleet suite red post-bump | Triage: fix-in-slice vs named follow-up; never pin-around | D1 risk carrier rule |

## 10. Testing strategy

`node:test` via tsx, `.mts`, explicit `.ts` extensions, NO TS parameter properties (Node 24 strip mode), 2-space, no AI attribution, no TODO/FIXME. **Fleet test layout is FLAT**: all 130 suites live as `test/*.test.mts` (the `test:run` glob is `test/*.test.mts` — non-recursive, so NO subdirectories). A new file matching the glob IS the liveness proof (fleet has no coverage script — its gate is `pnpm typecheck && pnpm test:run`).

- **`test/mcp-policy.test.mts`** (new): exact-tool deny; whole-server deny; server+tool both listed; no match → allow; absent/undefined/empty deny → allow; deny-list containing a malformed entry (shouldn't exist post-parse, but matcher ignores it) → no crash, no match.
- **`test/fleet-settings.test.mts`** (extend existing): `mcpDeny` valid array parses; mixed valid/invalid → warn per invalid + keep valid; non-array → warn + drop; `server__` / `__tool` / `server__*` / empty string / non-string entries all invalid; unknown-key warning still fires alongside; project-over-global for `mcpDeny`.
- **`test/gateway-adapter.test.mts`** (new, contract — gateway via dev `file:` link): successful import → `registerGovernanceProvider` called with a function; the real symbol store's governance slot is truthy (`globalThis[Symbol.for("@getpipher/armory-gateway:registry")]` — asserted via the store directly, NOT via any gateway export surface, so the test survives index re-export changes); provider denies a deny-listed call with the exact reason; allows otherwise; per-call freshness (mutate the backing store/files between calls → decision flips without re-registration); **duplicate-copy convergence**: import the gateway module twice via distinct resolution paths, register through one, assert the other's store sees it (gateway 1b-V2 pattern re-pinned from fleet's side); import failure (injected rejecting `importGateway`) → `{ registered: false }`, no throw, no registration.
- **Existing suites:** run green post-bump (V2) — no behavioral changes expected outside the new modules.

## 11. File structure delta (fleet repo)

```
package.json                              deps: 3× @earendil-works/* → ^0.84.4; devDep: file: link (see V1)
src/governance/mcp-policy.ts              NEW  pure matcher (D3)
src/governance/gateway-adapter.ts         NEW  guarded import + provider closure (D4)
src/settings/fleet-settings.ts            mcpDeny field + validation + known-set (D2)
src/index.ts                              boot wiring: registerMcpGovernance (imported directly from
                                          ./governance/gateway-adapter.ts — fleet convention is direct
                                          relative imports, no barrels) behind the guarded dynamic import (D4)
README.md                                 MCP governance section (D5)
test/governance/mcp-policy.test.mts       NEW
test/governance/gateway-adapter.test.mts  NEW
test/settings/fleet-settings.test.mts     extended
```

## 12. Plan-phase verification items (empirical, BEFORE plan freeze)

- **V1 — dev link resolvability:** add the gateway `file:` devDependency link into the fleet repo; verify named-export resolution of `@getpipher/armory-gateway` under (a) plain node/tsx for the test suite and (b) **jiti** (fleet's live loader context — gateway 1b-V1 proved the mechanism for gateway's own shape; re-verify for fleet's install shape). ALSO confirm gateway's own runtime deps (`@modelcontextprotocol/*`, typebox) resolve through the link under whichever mechanics the package manager applies (npm symlink vs pnpm copy) — the contract test imports gateway's root index, which transitively pulls the full gateway src tree. De-risks D4's import specifier choice before any plan code freezes.
- **V2 — the bump is the risk carrier:** bump the three `@earendil-works/*` deps to `^0.84.4` on a scratch branch; run fleet's FULL gate (test + typecheck + coverage, plus e2e where fleet defines it). Catalog every failure: 0.81→0.84 drift in `createAgentSession` signature, `ExtensionAPI` surface, `pi-tui` components, SessionManager behavior. Drift triages fix-in-slice vs named follow-up BEFORE plan freeze (the plan then prices reality, not hope).
- **V3 — typebox skew check:** only if V2 surfaces symptoms (schema-shape errors, typecheck conflicts). Contract passes plain objects/functions — no TypeBox instances cross the governance boundary.
- **V4 — settings store wiring:** read `src/index.ts`'s existing `FleetSettingsStore` construction (settings view + #78 consumer); decide reuse-vs-new for the provider's `loadDenyList` closure so there is exactly ONE store instance per construction site pattern (no duplicate path constants). *(Resolved 2026-08-30: the store lives at `src/index.ts:607` INSIDE the `session_start` handler (`dir = fleetDir(ctx.cwd)`), so D4's registration moves there too — per-session registration, idempotent under the gateway's replace-semantics, cwd-correct project path, and `loadDenyList` closes over the EXISTING `fleetSettingsStore` instance (`() => fleetSettingsStore.load().settings.mcpDeny`) rather than constructing a second store.)*

## 13. Acceptance criteria

- Full fleet gate green on `^0.84.4`: `pnpm typecheck && pnpm test:run` (fleet's actual gate — no coverage/e2e scripts exist in this repo); new test files flat in `test/` so the `test:run` glob picks them up.
- Contract tests prove: registration fires through the REAL gateway module; decisions route deny/allow correctly; per-call freshness; duplicate-copy convergence; absent-gateway silent skip.
- No static top-level import of `@getpipher/armory-gateway` anywhere in fleet src.
- README claims only wired behavior; `mcpDeny` documented with examples.
- No TODO/FIXME; no AI attribution; 2-space indent; no TS parameter properties.
- PR: `feat/1b-2-fleet-governance-adapter` branch → getpipher/armory-fleet; spec + plan relocate into fleet `docs/` at PR time (with as-built notes); gateway progress table gets a pointer line; merge `--merge --delete-branch`.

## 14. Follow-on slices (named, not in 1b-2)

1. **Cost sink** — when fleet grows an accounting home for MCP context-cost (per-call surface, storage, render): register `registerCostSink` from the same adapter module.
2. **Context story** — when children get MCP access (extension allowlist in `buildChildLoader` or gateway-as-customTool injection): design concurrency-safe agent/task context (AsyncLocalStorage or a gateway `AgentContextProvider` contract slot); THEN revisit ARMORY_* emission (env for any future process-spawned children only).
3. **Publish story** — gateway graduation (SPEC-1 §9) → gateway publishes → fleet adds optional peer + release-notes the linkage.
4. **Peer placement** — fleet `@earendil-works/*` dependencies → peerDependencies experiment (depends on pi package-manager peer semantics; would collapse the two-copy skew structurally).
5. **Per-call policy surface** — richer fleet policy (per-agent/per-run rules) when a real consumer exists.

## 15. Deferral rationale (durable record — the SPEC-1b §16 corrections)

**15.1 ARMORY_AGENT_ID / ARMORY_TASK_ID emission — deferred.** SPEC-1b §16 said 1b-2 emits these in child sessions. Survey falsified the premise (§3): pi children are in-process `noExtensions` sessions that never load gateway (no MCP calls, no reader); claude children are `claude`-CLI processes that never load gateway either; and per-spawn `process.env` writes in the shared parent process are racy + leak into parent-scope governance. There is no code path on which emitted env is read. Revival conditions: child MCP access lands (follow-on 2) AND a concurrency-safe context mechanism exists — env remains the right channel only for genuinely process-spawned backends. Until then, parent-originated calls pass `agent`/`task` = `undefined`, which the gateway contract already treats as first-class ("no scoping context").

**15.2 Cost sink — deferred.** SPEC-1 §5 maps CostMeter→fleet, but fleet has no per-MCP-call accounting surface (costTotal is per-run LLM usage). Registering a sink with nowhere to put data is write-only plumbing. Follow-on 1 gates on the surface existing.

**15.3 What "fleet governance adapter" means as shipped (honest scope).** One contract method (`registerGovernanceProvider`), one settings field (`mcpDeny`), one pure matcher, one guarded import — governing the only MCP call origin that exists today (the parent/orchestrator session). This fully wires graduation-gate #3's mechanism (fleet routes MCP through the governance gate); the gate's multi-agent *breadth* (calls from run contexts) waits on follow-on 2, and that sequencing is now explicit instead of assumed.
