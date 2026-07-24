# Design: scratch-hello.ts

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Single scratch file — `scripts/scratch-hello.ts`

## Purpose

Add a `hello()` function to a scratch file that returns the string `'hello from fleet'`. This is a throwaway utility stub — not part of the published package surface, not imported by `src/`, and not part of the CI test gate.

## Approach

**Chosen: Plain export, no side effects.**

A scratch file should be minimal and importable. No `main()`, no `console.log`, no self-test assertion. Just the function.

### Alternatives considered

- **Export + self-invoking main** — Adds a runnable entry point (`node --import tsx scripts/scratch-hello.ts` prints output). Rejected: unnecessary for a scratch stub; the function is the deliverable, not a CLI.
- **Export + inline self-test** — Combines function with an assertion. Rejected: over-engineered for a throwaway file.

## Specification

### File: `scripts/scratch-hello.ts`

```ts
export function hello(): string {
  return 'hello from fleet';
}
```

- **Extension:** `.ts` (per task specification; matches project's raw-TS-via-tsx convention)
- **Export:** Named export `hello`
- **Return type:** Explicit `: string` (strict mode, project convention)
- **Return value:** String literal `'hello from fleet'`
- **Imports:** None
- **Side effects:** None

### Out of scope

- No test file (`test/*.test.mts`) — scratch file, not CI-gated
- No `package.json` script entry — not a runnable target
- No import from `src/` — standalone stub
- No JSDoc — single-line function is self-documenting

## Non-goals

- This file is NOT part of the published package (`package.json` `files` array excludes `scripts/`)
- This file is NOT covered by `tsconfig.json` (only `src` and `test` are included)
- This file will NOT be typechecked by `pnpm typecheck` or tested by `pnpm test:run`