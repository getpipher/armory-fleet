export const meta = {
  name: 'codebase-audit',
  description: 'File-tree scan with completeness check',
  phases: [{ title: 'Scan' }, { title: 'Audit' }],
}

phase('Scan')
const files = await loopUntilDry({
  round: (n) => n < 4 ? agent(`List files in dir ${n}.`, { tier: 'low' }) : [],
  consecutiveEmpty: 2,
  maxRounds: 6,
})

phase('Audit')
const checked = await verify(`Found ${files.length} files.`, { reviewers: 1, lens: 'missing test coverage' })
return { files, checked }

