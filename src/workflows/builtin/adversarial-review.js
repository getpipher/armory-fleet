export const meta = {
  name: 'adversarial-review',
  description: 'Red-team + blue-team review with judge panel',
  phases: [{ title: 'Attack' }, { title: 'Defend' }, { title: 'Judge' }],
}

phase('Attack')
const vulns = await parallel([
  () => agent('Find injection vulnerabilities in this code.', { tier: 'standard' }),
  () => agent('Find logic errors and race conditions.', { tier: 'standard' }),
  () => agent('Find authentication bypass vectors.', { tier: 'standard' }),
])

phase('Defend')
const defenses = await parallel(vulns.map((v) => () => agent(`Propose a fix for: ${v}`, { tier: 'economy' })))

phase('Judge')
const winner = await judgePanel([...vulns, ...defenses], { judges: 3, rubric: 'severity and fixability' })
return { vulnerabilities: vulns, defenses, verdict: winner }
