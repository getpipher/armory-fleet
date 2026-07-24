# scratch-hello Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `hello()` function to `scripts/scratch-hello.ts` that returns the string `'hello from fleet'`.

**Architecture:** Single-file library-style module. One named export, no imports, no side effects. The file lives outside `tsconfig.json`'s include scope and `package.json`'s `files` array — it is not typechecked, tested, or published.

**Tech Stack:** TypeScript (raw `.ts` via tsx at runtime), ESM (`"type": "module"`).

## Global Constraints

- File extension: `.ts` (not `.mts`)
- Export style: named export (`export function hello`)
- Return type: explicit `: string` (strict mode convention)
- Return value: string literal `'hello from fleet'`
- No imports, no side effects, no `main()`, no `console.log`
- No test file — scratch file is outside CI gate per design spec
- 2-space indentation, trailing semicolons (match project convention)

---

### Task 1: Create scripts/scratch-hello.ts with hello() function

**Files:**
- Create: `scripts/scratch-hello.ts`

**Interfaces:**
- Consumes: nothing (zero imports)
- Produces: `export function hello(): string` — returns `'hello from fleet'`

- [ ] **Step 1: Create the file with the hello() function**

Create `scripts/scratch-hello.ts` with exactly this content:

```ts
export function hello(): string {
  return 'hello from fleet';
}
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `cat scripts/scratch-hello.ts`

Expected output:
```
export function hello(): string {
  return 'hello from fleet';
}
```

- [ ] **Step 3: Verify the function works at runtime**

Run: `node --import tsx --eval "import { hello } from './scripts/scratch-hello.ts'; console.log(hello());"`

Expected output:
```
hello from fleet
```

- [ ] **Step 4: Verify no side effects on import**

Run: `node --import tsx --eval "import './scripts/scratch-hello.ts'; console.log('no side effects');"`

Expected output:
```
no side effects
```

(If any output appears before "no side effects", the file has unintended side effects.)

- [ ] **Step 5: Commit**

```bash
git add scripts/scratch-hello.ts
git commit -m "feat: add scratch-hello.ts with hello() function"
```