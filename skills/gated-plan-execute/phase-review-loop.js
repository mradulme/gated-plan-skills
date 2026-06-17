export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially via a subagent, gate each commit on a review loop, then gate the whole branch vs main — review tries Kimi, then GLM-5.2 (opencode), then codex, each on its coding plan',
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

// Ordered reviewer chain, tried in order until one produces a review. All three are AGENTIC — they
// explore the repo with their own tools (run git, read files); we never hand them a pre-dumped diff.
// All assumed preconfigured (logged in, on their coding plans — never set keys/models here). Each
// prints findings as text, so one classifier handles all. The chain falls through to the next
// reviewer ONLY when the current one can't review because it's out of credits/quota/rate-limit/auth:
//   1. Kimi (its coding plan)    — native CLI: `kimi -p "<prompt>"`
//   2. GLM-5.2 (its coding plan) — via opencode (no native CLI): `opencode run "<prompt>" -m zai-coding-plan/glm-5.2`
//   3. codex (last resort, slow) — native, reviews git itself: `codex exec review --commit HEAD` / `--base <reviewBase>`
const GLM_MODEL = 'zai-coding-plan/glm-5.2'
const codexCmd = (target) =>
  target === 'branch'
    ? `codex exec review --base ${reviewBase}${modelFlag}`
    : `codex exec review --commit HEAD${modelFlag}`

const reviewAgent = (target, label) => {
  const scope =
    target === 'branch'
      ? `this branch vs \`${reviewBase}\` (the changes in \`git diff ${reviewBase}...HEAD\`)`
      : `the latest commit (the changes in \`git diff HEAD~1 HEAD\`)`
  // One agentic review instruction reused for kimi + opencode; codex has its own built-in review prompt.
  const p =
    `Review ${scope} for correctness. Run git and read the surrounding code as needed — investigate, ` +
    `do not just skim the diff. List P1 (must-fix: bug, regression, security, data loss) and P2 ` +
    `(correctness risk, missing edge case) issues with file:line. Ignore style/nits. Make NO edits.`
  return agent(
    `On branch \`${branch}\`, review ${scope}. Try these reviewers STRICTLY ONE AT A TIME, IN ORDER. ` +
      `Run exactly ONE reviewer command per Bash call, WAIT for it to finish, then decide. NEVER run two ` +
      `reviewers in parallel — no parallel Bash calls. Classify the output of the FIRST that produces a ` +
      `review and STOP (do not run the others). Move to the next ONLY if the current one fails because it is ` +
      `out of credits/quota/rate-limit/auth (NOT because it found issues, and NOT for any other error). The ` +
      `binaries are at absolute paths below (the shell does not source ~/.zshrc) — use those paths verbatim. ` +
      `Each is agentic — let it explore the repo; do not pre-dump the diff:\n\n` +
      `  1. Kimi (coding plan):   $HOME/.kimi-code/bin/kimi -p "${p}"\n` +
      `  2. GLM via opencode:     $HOME/.opencode/bin/opencode run "${p}" -m ${GLM_MODEL}\n` +
      `  3. codex (last resort — slow, WAIT for it, 4-8 min, Bash timeout 600000 ms): ${codexCmd(target)}\n\n` +
      `Assume all three are installed and logged in — do NOT configure keys/models. Whichever runs prints ` +
      `findings as text. Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) and ` +
      `P2 (should-fix: correctness risk, missing edge case). Ignore P3/nits/style. Return the structured result. Edit nothing.`,
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
