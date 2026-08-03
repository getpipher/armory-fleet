// SPEC-6-3 §9 — bounded keyword authorization for workflow capability.
// Returns a bounded system hint when the prompt mentions "workflow"/"workflows"
// as a standalone word (not as part of an identifier or file path).

const WORKFLOW_KEYWORD = /(?:^|[^A-Za-z0-9_])workflows?(?=$|[^A-Za-z0-9_])/i

export function workflowKeywordHint(prompt: string): string | undefined {
  const match = prompt.match(WORKFLOW_KEYWORD)
  if (!match) return undefined

  const fullMatch = match[0]!
  // If the match includes a preceding non-word char, check if it's a path separator.
  const firstChar = fullMatch[0]!
  if (firstChar === "/" || firstChar === ".") return undefined

  // Check the character after "workflow" in the original string.
  const afterIdx = (match.index ?? 0) + fullMatch.length
  const afterChar = prompt[afterIdx]
  if (afterChar === "-" || afterChar === ".") return undefined

  return "workflow capability authorized — use action:'workflow' with a script or workflowName"
}
