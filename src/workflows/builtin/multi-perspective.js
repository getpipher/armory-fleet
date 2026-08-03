export const meta = {
  name: 'multi-perspective',
  description: '4 personas review the same artifact',
  phases: [{ title: 'Review' }, { title: 'Merge' }],
}

phase('Review')
const personas = ['product manager', 'security engineer', 'UX designer', 'dev-ops lead']
const reviews = await parallel(personas.map((p) => () => agent(`Review this artifact as a ${p}. Focus on your domain only.`, { tier: 'medium' })))

phase('Merge')
const merged = await gate(
  async (feedback, n) => n === 0 ? agent(`Initial synthesis of ${reviews.length} reviews.`, { tier: 'low' }) : agent(`Revise synthesis: ${feedback}`, { tier: 'low' }),
  (v) => typeof v === 'string' && v.length > 100 ? { ok: true } : { ok: false, feedback: 'more detail needed' },
  { attempts: 3 },
)
return { reviews, synthesis: merged }
