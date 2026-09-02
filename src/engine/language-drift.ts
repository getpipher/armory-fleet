// src/engine/language-drift.ts
// #88: cheap post-run signal for non-English drift in subagent final reports. Observed:
// zai/glm-5.3-flash drifted into Chinese for all or part of the report in 4/7 dispatches
// — even with an explicit English-only instruction in the dispatch prompt. Findings were
// sound every time, so this is FLAGGING, not blocking: the controller decides whether to
// re-dispatch or translate. Spec: docs/superpowers/specs/2026-09-02-spec-language-drift-flag.md
//
// Scope (deliberate): CJK-family scripts (Han / Hiragana / Katakana / Hangul) — the drift
// family actually observed on the model tiers the fleet steers people to. Quoted CJK
// content inside an otherwise-English report stays well under the threshold; a
// majority-CJK report trips it. Latin-script non-English (fr/de/…) is NOT detected — see
// spec N3.

export interface LanguageDrift {
  /** true when the CJK-family letter ratio crossed DRIFT_RATIO (and MIN_LETTERS was met). */
  drift: boolean;
  /** CJK-family letters / total letters (0 when the text has no letters). */
  ratio: number;
}

/** CJK-family: Hiragana+Katakana (3040–30FF), CJK ext-A (3400–4DBF), CJK Unified
 *  (4E00–9FFF), Hangul syllables (AC00–D7AF), CJK compat ideographs (F900–FAFF). */
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;
/** Letter population: ASCII + Latin-extended + the CJK family (denominator for the ratio). */
const LETTER_RE = /[A-Za-z\u00C0-\u024F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

/** Ratio at or above which a report is considered drifted. 0.3 ≈ a third of the letters —
 *  comfortably above any plausible quoting noise, well below the ~0.5 mixed-report case. */
export const DRIFT_RATIO = 0.3;

/** Reports shorter than this can't be triaged (a one-line verdict quoting '通过' must not flag). */
export const MIN_LETTERS = 40;

export function detectLanguageDrift(text: string): LanguageDrift {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const letters = (text.match(LETTER_RE) ?? []).length;
  if (letters === 0) return { drift: false, ratio: 0 };
  const ratio = cjk / letters;
  return { drift: letters >= MIN_LETTERS && ratio >= DRIFT_RATIO, ratio };
}
