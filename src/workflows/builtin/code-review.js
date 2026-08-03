export const meta = {
  name: 'code-review',
  description: '7 parallel review angles plus verification',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

phase('Review')
const angles = ['security', 'correctness', 'performance', 'readability', 'edge-cases', 'tests', 'api-design']
const findings = await parallel(angles.map((angle) => () => agent(`Review this diff for ${angle} issues. Report concrete findings only.`, { tier: 'medium' })))

phase('Verify')
const verified = await verify(findings.join('\n---\n'), { reviewers: 2, lens: 'false positives' })
return { findings, verified }
