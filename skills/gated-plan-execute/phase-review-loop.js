export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially via a subagent, then gate each commit on a codex review loop until no P1/P2',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a codex review gate per commit',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   reviewTarget: 'commit'|'base' (default 'commit'), reviewBase='main', codexModel?, maxRounds=3,
//   items: [{ label, prompt }]
// }
// args may arrive as an object or, depending on the harness, a JSON string — normalize both.
const _args = typeof args === 'string' ? JSON.parse(args) : args || {}
const {
  phaseTitle = 'Phase',
  branch,
  base = 'release',
  reviewTarget = 'commit',
  reviewBase = 'main',
  codexModel,
  maxRounds = 3,
  items = [],
} = _args

if (!branch) throw new Error('args.branch is required (e.g. "phase/1-eslint")')
if (!items.length) throw new Error('args.items must be a non-empty list of {label, prompt}')

const modelFlag = codexModel ? ` -m ${codexModel}` : ''
const REVIEW = {
  type: 'object',
  additionalProperties: false,
  required: ['p1', 'p2', 'summary'],
  properties: {
    p1: { type: 'array', items: { type: 'string' } },
    p2: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

phase(phaseTitle)

await agent(
  `Run from the repo root: if branch \`${branch}\` exists check it out, else \`git checkout -b ${branch} ${base}\`. Print \`git status -sb\`. Change no files.`,
  { label: `branch:${branch}`, phase: phaseTitle }
)

const unresolved = []

for (const item of items) {
  await agent(
    `You are on git branch \`${branch}\`. Implement EXACTLY this one checklist item, nothing else:\n\n${item.prompt}\n\n` +
      `Follow repo conventions (TDD where adding behavior). When the item is done AND its named gate is green ` +
      `(run the specific check it names — the project's lint/typecheck/test command), ` +
      `\`git add\` + \`git commit\` with a conventional message + the repo's Co-Authored-By trailer. ` +
      `If already satisfied, say so and make no commit.`,
    { label: `impl:${item.label}`, phase: phaseTitle }
  )

  const reviewCmd =
    reviewTarget === 'base'
      ? `codex exec review --base ${reviewBase}${modelFlag} --color never`
      : `codex exec review --commit HEAD${modelFlag} --color never`

  let round = 0
  let blockers = []
  while (round < maxRounds) {
    round++
    const review = await agent(
      `On branch \`${branch}\`, run this codex review and WAIT for it (slow, 4-8 min — Bash timeout 600000 ms):\n\n    ${reviewCmd}\n\n` +
        `codex prints findings as text. Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) and ` +
        `P2 (should-fix: correctness risk, missing edge case). Ignore P3/nits/style. Return the structured result. Edit nothing.`,
      { label: `review:${item.label}#${round}`, phase: phaseTitle, schema: REVIEW }
    )
    blockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!blockers.length) {
      log(`✓ ${item.label}: codex clean (round ${round})`)
      break
    }
    log(`↻ ${item.label}: ${blockers.length} blocker(s) round ${round} — fixing`)
    await agent(
      `On branch \`${branch}\`, codex flagged these on "${item.label}". Fix ALL properly (no suppression), re-run the item's gate green, then commit:\n\n` +
        blockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      { label: `fix:${item.label}#${round}`, phase: phaseTitle }
    )
  }
  if (blockers.length) unresolved.push({ item: item.label, blockers })
}

return { branch, itemsDone: items.length, unresolved }
