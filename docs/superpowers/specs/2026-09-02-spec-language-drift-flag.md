# Spec: #88 — language-drift flag in subagent result envelopes

**Date:** 2026-09-02 · **Status:** approved (RECTOR: "do you rec, full power") · **Issue:** #88

## Problem

On the 2026-08-31 armory-gateway SDD run, `zai/glm-5.3-flash` drifted into Chinese for all
or part of the final report in **4 of 7 dispatches** — including two whose dispatch prompt
contained an explicit "RESPOND IN ENGLISH ONLY" instruction. Findings were sound every
time; the friction is that the controller has **no cheap signal** and must eyeball every
verdict line. The drift family (CJK) is specific to the model tier the fleet steers people
to (flat z.ai/GLM plans).

## Goals

- G1: controller gets a machine-readable flag on every dispatch whose final report is
  majority CJK-family script — without reading the report.
- G2: flag is **additive, surfacing-only** (the #61 precedent): never blocks, never
  rewrites, never re-dispatches on its own.
- G3: survives the journal — a drifted run is diagnosable post-hoc from `run:ended`
  (the #59/#60/#61 pattern: terminal facts land in the journal, not just the result).
- G4: zero config by default; no new required settings, no dispatch-param surface yet.

## Non-goals

- N1: **Not** auto re-dispatch / auto-translate (controller's call).
- N2: **Not** the `resultLanguage` system-side preference (issue's "optional") —
  dispatch-prompt placement demonstrably isn't enough and a system-prompt edit changes
  every child's substrate; re-file standalone if wanted.
- N3: **Not** Latin-script non-English detection (fr, de, …): legitimate quoted content
  would false-positive, and the observed drift family is CJK. Scope is documented in the
  detector.

## Design decisions

- **D1 — signal: CJK-family letter ratio over the final message.**
  `detectLanguageDrift(text)` counts Han/Hiragana/Katakana/Hangul codepoints over the
  letter population (Latin + Latin-extended + CJK family). Flags when ratio ≥ 0.3 AND
  letters ≥ 40 (short strings can't triage). Constants exported + tunable.
  Alternatives rejected: full language-ID library (dependency weight for a heuristic);
  any-non-ASCII (false-positives on quotes/emoji/CJK identifiers).
- **D2 — detection site: `finishRun`** (single composition point for every terminal path —
  direct, fallback retry, turn-budget; both backends since it reads `finalText`).
  Computed once, placed on the SpawnResult + journaled.
- **D3 — SpawnResult surface:** `languageDrift?: boolean` + `languageDriftRatio?: number`
  (ratio gives severity; boolean is the greppable flag the issue asked for).
  `run:ended` gains `languageDrift?: boolean` + `languageDriftRatio?: number`
  (**additive** — the frozen RPC/journal surface allows additive fields; pinned tests
  updated, no renames).
- **D4 — tool output: one-line warning prefix** (mirrors #61's zero-tool prefix):
  `[FLEET] language drift — final report is N% CJK-family script (#88); findings may
  still be sound — re-dispatch or translate if the controller requires English.`
  Only on non-error results (a failed run's error text needs no drift triage).
  Details expose both fields.

## Wiring

1. `src/engine/language-drift.ts` (new): pure detector + constants.
2. `src/engine/spawnSubagent.ts` `finishRun`: compute, return on both paths, journal.
3. `src/runtime/run-log.ts` `RunEndedEvent`: additive optional fields.
4. `src/tools/subagent.ts`: warning prefix + `details`.

## Test plan

- Pure detector: English no-drift; pure-CJK drift; ~50% mixed drift; Korean/Japanese in
  family; short-text floor; empty string.
- Tool wiring: drifted child → prefix + details fields; English child → no prefix,
  `languageDrift` undefined; journaled `run:ended` carries the flag (RunLog replay).
- All env-independent (no providers, tmpdir only).
