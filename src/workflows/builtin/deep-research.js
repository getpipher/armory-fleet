export const meta = {
  name: 'deep-research',
  description: '3-round discovery loop with de-duplication',
  phases: [{ title: 'Discover' }, { title: 'Synthesize' }],
}

phase('Discover')
const topics = await loopUntilDry({ round: (n) => n < 3 ? agent(`Find unique sources for round ${n}. Return a JSON array of source strings.`, { tier: 'low', schema: { type: 'array' }, retries: 1 }) : [], consecutiveEmpty: 2, maxRounds: 5 })

phase('Synthesize')
const summary = await agent(`Synthesize these ${topics.length} sources into a coherent report.`, { tier: 'medium' })
return { sources: topics, summary }

