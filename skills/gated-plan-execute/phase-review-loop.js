export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially via a subagent, gate each commit on a review loop, then gate the whole branch vs main — review by codex, falling back to OCR+GLM when codex is out of quota',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a review gate per commit plus a final branch-vs-main gate',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   goal?, phaseIntent?,        // bigger-picture context prepended to each item's impl prompt
//   reviewBase='main',          // the final branch review compares the branch against this
//   codexModel?, maxRounds=7,   // maxRounds = per-commit rounds; the final branch gate uses BRANCH_MAX
//   items: [{ label, prompt, gate }]   // gate = the runnable check (lint/typecheck/test) that must pass
// }
// args may arrive as an object or, depending on the harness, a JSON string — normalize both.
const _args = typeof args === 'string' ? JSON.parse(args) : args || {}
const {
  phaseTitle = 'Phase',
  goal,
  phaseIntent,
  branch,
  base = 'release',
  reviewBase = 'main',
  codexModel,
  maxRounds = 7,
  items = [],
} = _args

// Bigger-picture context prepended to each impl prompt so a subagent knows how its one item fits.
const context = [
  goal && `Bigger goal:\n${goal}`,
  phaseIntent && `This phase — ${phaseTitle}:\n${phaseIntent}`,
]
  .filter(Boolean)
  .join('\n\n')
const contextBlock = context ? `${context}\n\n---\n\n` : ''

if (!branch) throw new Error('args.branch is required (e.g. "phase/1-eslint")')
if (!items.length) throw new Error('args.items must be a non-empty list of {label, prompt, gate}')

const BRANCH_MAX = 3 // rounds for the final branch-vs-main gate
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
const GATE = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'detail'],
  properties: {
    pass: { type: 'boolean' },
    detail: { type: 'string' },
  },
}

// Primary reviewer = OCR (Alibaba open-code-review) pointed at GLM via its own env config
// (OCR_LLM_URL/TOKEN/MODEL — see SKILL.md) since GLM's Coding Plan is the cheap subscription;
// fallback = codex. Both print findings as text, so one classifier handles either. The subagent
// uses codex ONLY when OCR fails to review because its GLM credits/quota are exhausted.
const reviewCmds = (target) =>
  target === 'branch'
    ? {
        primary: `ocr review --from ${reviewBase} --to ${branch}`,
        fallback: `codex exec review --base ${reviewBase}${modelFlag} --color never`,
      }
    : {
        primary: `ocr review --commit HEAD`,
        fallback: `codex exec review --commit HEAD${modelFlag} --color never`,
      }

const reviewAgent = (target, label) => {
  const { primary, fallback } = reviewCmds(target)
  return agent(
    `On branch \`${branch}\`, review the ${target === 'branch' ? `whole branch against \`${reviewBase}\`` : 'latest commit'} ` +
      `by running this:\n\n    ${primary}\n\n` +
      `ONLY if that fails to produce a review because OCR/GLM is out of credits/quota/rate-limit ` +
      `(NOT because it found issues, and NOT for any other error), run the fallback reviewer instead and classify ITS output ` +
      `(codex is slow — WAIT for it, 4-8 min, Bash timeout 600000 ms):\n\n    ${fallback}\n\n` +
      `Whichever runs prints findings as text. Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) ` +
      `and P2 (should-fix: correctness risk, missing edge case). Ignore P3/nits/style. Return the structured result. Edit nothing.`,
    { label, phase: phaseTitle, schema: REVIEW }
  )
}

phase(phaseTitle)

await agent(
  `Run from the repo root: if branch \`${branch}\` exists check it out, else \`git checkout -b ${branch} ${base}\`. Print \`git status -sb\`. Change no files.`,
  { label: `branch:${branch}`, phase: phaseTitle }
)

const unresolved = []

for (const item of items) {
  await agent(
    `${contextBlock}You are on git branch \`${branch}\`. Implement EXACTLY this one checklist item, nothing else:\n\n${item.prompt}\n\n` +
      `Follow repo conventions (TDD where adding behavior). When the item is done AND its named gate is green ` +
      `(run the specific check it names — the project's lint/typecheck/test command), ` +
      `\`git add\` + \`git commit\` with a conventional message + the repo's Co-Authored-By trailer. ` +
      `If already satisfied, say so and make no commit.`,
    { label: `impl:${item.label}`, phase: phaseTitle }
  )

  let round = 0
  let blockers = []
  let gateRed = false
  while (round < maxRounds) {
    round++

    // Hard precondition: the committed HEAD must pass the item's own gate BEFORE we spend
    // 4-8 min on review. Re-run every round — a prior fix could have broken it.
    if (item.gate) {
      const g = await agent(
        `On branch \`${branch}\` at HEAD, run the verification gate for "${item.label}" and report whether it passes. ` +
          `Gate: ${item.gate}\n\nRun the exact command(s) it names (the project's lint/typecheck/test) and check exit status. ` +
          `Return { pass, detail } where detail is the tail of the output (and which command failed, if any). Make NO edits and NO commits.`,
        { label: `gate:${item.label}#${round}`, phase: phaseTitle, schema: GATE }
      )
      if (!g?.pass) {
        gateRed = true
        log(`✗ ${item.label}: gate RED round ${round} — fixing before review`)
        await agent(
          `On branch \`${branch}\`, the gate for "${item.label}" is RED:\n\n${g?.detail || 'gate command failed'}\n\n` +
            `Fix the code so the gate (${item.gate}) passes green — no suppression, no skipping tests — then commit. Change only what's needed.`,
          { label: `gatefix:${item.label}#${round}`, phase: phaseTitle }
        )
        continue // re-verify the gate next round; review does not run on a red gate
      }
      gateRed = false
    }

    const review = await reviewAgent('commit', `review:${item.label}#${round}`)
    blockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!blockers.length) {
      log(`✓ ${item.label}: gate green + review clean (round ${round})`)
      break
    }
    log(`↻ ${item.label}: ${blockers.length} blocker(s) round ${round} — fixing`)
    await agent(
      `On branch \`${branch}\`, the review flagged these on "${item.label}". Fix ALL properly (no suppression), re-run the item's gate green, then commit:\n\n` +
        blockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      { label: `fix:${item.label}#${round}`, phase: phaseTitle }
    )
  }
  if (gateRed) unresolved.push({ item: item.label, blockers: [`gate never green within ${maxRounds} rounds: ${item.gate}`] })
  else if (blockers.length) unresolved.push({ item: item.label, blockers })
}

// Final gate: review the WHOLE branch against reviewBase to catch cross-commit interactions the
// per-commit gates can't see. Loop-fix like the per-commit gate, then hand back for the merge decision.
let branchBlockers = []
{
  let round = 0
  while (round < BRANCH_MAX) {
    round++
    const review = await reviewAgent('branch', `branch-review#${round}`)
    branchBlockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!branchBlockers.length) {
      log(`✓ branch ${branch}: clean vs ${reviewBase} (round ${round})`)
      break
    }
    log(`↻ branch ${branch}: ${branchBlockers.length} blocker(s) round ${round} — fixing`)
    await agent(
      `On branch \`${branch}\`, the full-branch review vs \`${reviewBase}\` flagged these. Fix ALL properly (no suppression), ` +
        `re-run the affected gates green, then commit:\n\n` +
        branchBlockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      { label: `branchfix#${round}`, phase: phaseTitle }
    )
  }
}

return { branch, itemsDone: items.length, unresolved, branchUnresolved: branchBlockers }
