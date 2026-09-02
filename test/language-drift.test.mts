// test/language-drift.test.mts — #88: pure detector for CJK-family drift in final reports.
// Spec: docs/superpowers/specs/2026-09-02-spec-language-drift-flag.md
import { test } from "node:test";
import { strictEqual } from "node:assert";
import { detectLanguageDrift, DRIFT_RATIO, MIN_LETTERS } from "../src/engine/language-drift.ts";

test("#88: English report → no drift, ratio 0", () => {
  const r = detectLanguageDrift("The review is complete. All 5 findings verified against the diff; verdict: ship.");
  strictEqual(r.drift, false);
  strictEqual(r.ratio, 0);
});

test("#88: pure-CJK report → drift, ratio 1", () => {
  const r = detectLanguageDrift("审查已完成。所有五个发现均已针对差异进行验证。结论：通过。代码质量良好，没有明显的问题，可以合并这条分支。");
  strictEqual(r.drift, true);
  strictEqual(r.ratio, 1);
});

test("#88: half-Chinese mixed report → drift (the observed 4/7 failure mode)", () => {
  // English verdict line + Chinese analysis body — the drift was "all or part".
  const mixed =
    "Verdict: ship with nits. " +
    "审查已完成。所有五个发现均已针对差异进行验证，代码质量良好，没有明显的问题需要修复。";
  const r = detectLanguageDrift(mixed);
  strictEqual(r.drift, true, "mixed report with a CJK-majority body flags");
});

test("#88: mostly-English with a few CJK quotes → no drift (quoted content must not trip it)", () => {
  const r = detectLanguageDrift(
    "The helper validateUser in src/auth.ts rejects empty names. The Chinese error message '用户名不能为空' is quoted verbatim from the fixture. Everything else checks out fine.",
  );
  strictEqual(r.drift, false, "short quoted CJK inside an English report stays clean");
});

test("#88: Hangul is in the drift family", () => {
  const r = detectLanguageDrift("리뷰가 완료되었습니다. 모든 다섯 가지 발견이 차이점에 대해 검증되었으며 코드 품질이 좋습니다.");
  strictEqual(r.drift, true);
});

test("#88: Kana is in the drift family", () => {
  const r = detectLanguageDrift("レビューが完了しました。すべての五つの発見が差分に対して検証されており、コードの品質は良好です。");
  strictEqual(r.drift, true);
});

test("#88: short text under MIN_LETTERS → never flags (can't triage)", () => {
  const r = detectLanguageDrift("通过。");
  strictEqual(r.drift, false, "below the letter floor");
  strictEqual(r.ratio, 1, "ratio still reported honestly");
  strictEqual(typeof MIN_LETTERS, "number");
  strictEqual(typeof DRIFT_RATIO, "number");
});

test("#88: empty text → no drift, ratio 0", () => {
  const r = detectLanguageDrift("");
  strictEqual(r.drift, false);
  strictEqual(r.ratio, 0);
});
