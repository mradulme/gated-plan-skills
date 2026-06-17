export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially via a subagent, gate each commit on a review loop, then gate the whole branch vs main — review tries gpt-5.5, GLM-5.2, Claude Sonnet, then Kimi (cline for all but Claude), using the first with quota',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a review gate per commit plus a final branch-vs-main gate',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   goal?, phaseIntent?,        // bigger-picture context prepended to each item's impl prompt
//   reviewBase='main',          // the final branch review compares the branch against this
//   maxRounds=7,                // maxRounds = per-commit rounds; the final branch gate uses BRANCH_MAX
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

// Reviewer FALLBACK order — exactly ONE reviewer runs per review; the next is tried ONLY if the
// current one can't review. Not parallel, not stacked. All are AGENTIC — each explores
// the repo with its own tools (runs git, reads files); we never hand it a pre-dumped diff. All assumed
// preconfigured (cline providers logged in / claude logged in — never set keys/models here). Each
// prints findings as text, so one classifier handles all. The chain falls through to the next reviewer
// ONLY when the current one can't review because it's out of credits/quota/rate-limit/auth (for cline
// this often shows up as an unauthenticated / not-logged-in / expired-token error — treat that as quota):
//   1. gpt-5.5        — cline -p -P openai-codex    -m gpt-5.5
//   2. GLM-5.2        — cline -p -P zai-coding-plan -m glm-5.2
//   3. Claude (Sonnet)— claude -p --model claude-sonnet-4-6, read-only tool whitelist (spends main Claude credits)
//   4. Kimi           — cline -p -P moonshot        -m kimi-k2.7-code  (LAST)
// cline `-p` is PLAN MODE: it investigates but cannot edit (our read-only enforcement). claude `-p` is
// print mode; its read-only comes from --allowedTools. Absolute paths: the review shell doesn't source
// ~/.zshrc. No --json (it re-emits every event — token bloat); redirect to a temp file and tail it.
const CLINE = '/opt/homebrew/bin/cline'
const CLAUDE = '$HOME/.local/bin/claude'

const reviewAgent = (target, label) => {
  const scopeMd =
    target === 'branch'
      ? `this branch vs \`${reviewBase}\` (the changes in \`git diff ${reviewBase}...HEAD\`)`
      : `the latest commit (the changes in \`git diff HEAD~1 HEAD\`)`
  const ref = target === 'branch' ? `${reviewBase}...HEAD` : 'HEAD~1 HEAD'
  // Unique per-review temp paths so concurrent plan runs can't cross-read each other's output
  // (a stale/partial read could otherwise look like a clean review). slug from the review label.
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const tmp = (n) => `/tmp/gpe-${slug}-${n}.txt`
  // Agentic review instruction reused for all reviewers. NOTE: kept free of backticks, $ and
  // double-quotes so it embeds safely inside the double-quoted shell arg below (no command substitution).
  const p =
    `Review ${target === 'branch' ? `this branch against ${reviewBase}` : 'the latest commit'} for ` +
    `correctness. Run git (e.g. git diff ${ref}) and read the surrounding code as needed — investigate, ` +
    `do not just skim. List P1 (must-fix: bug, regression, security, data loss) and P2 (correctness risk, ` +
    `missing edge case) issues with file:line. Ignore style/nits. Make NO edits.`
  return agent(
    `On branch \`${branch}\`, review ${scopeMd}. Try these reviewers STRICTLY ONE AT A TIME, IN ORDER. ` +
      `Run exactly ONE reviewer command per Bash call (Bash timeout 600000 ms), WAIT for it to finish, then ` +
      `decide. NEVER run two reviewers in parallel — no parallel Bash calls. Each CLINE command (1, 2, 4) ` +
      `redirects to its own temp file and tails it: read ONLY that tail (the final findings) — do NOT use ` +
      `--json (it dumps the whole event stream); claude (3) prints its final answer directly, no redirect. ` +
      `Classify the output of the FIRST that produces a review and STOP (do not run the others). ` +
      `Move to the next ONLY if the current one fails because it cannot review — out of credits/quota/rate-limit, ` +
      `OR (for cline) an auth / unauthenticated / not-logged-in / expired-or-invalid-token error, which is how ` +
      `cline surfaces an exhausted plan (observed examples: a single-line "error: The usage limit has been ` +
      `reached" or "error: Invalid Authentication", exit 1). Do NOT fall through because it found issues (that ` +
      `is a valid review) or for any other error. cline runs in PLAN MODE (-p) so it investigates but cannot edit; claude is read-only ` +
      `via --allowedTools. Use the absolute paths verbatim (the shell does not source ~/.zshrc). Each is agentic ` +
      `— let it explore the repo; do not pre-dump the diff:\n\n` +
      `  1. gpt-5.5:  ${CLINE} -p -P openai-codex -m gpt-5.5 "${p}" > ${tmp(1)} 2>&1; tail -n 120 ${tmp(1)}\n` +
      `  2. GLM-5.2:  ${CLINE} -p -P zai-coding-plan -m glm-5.2 "${p}" > ${tmp(2)} 2>&1; tail -n 120 ${tmp(2)}\n` +
      `  3. Claude Sonnet (spends main Claude credits): ${CLAUDE} -p "${p}" --model claude-sonnet-4-6 --allowedTools "Bash(git:*)" "Read" "Grep" "Glob"\n` +
      `  4. Kimi (LAST): ${CLINE} -p -P moonshot -m kimi-k2.7-code "${p}" > ${tmp(4)} 2>&1; tail -n 120 ${tmp(4)}\n\n` +
      `Assume all are configured and logged in — do NOT configure keys/models. Whichever runs prints ` +
      `findings as text. Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) and ` +
      `P2 (should-fix: correctness risk, missing edge case). Ignore P3/nits/style. Edit nothing. If EVERY reviewer ` +
      `fails (all out of quota/auth) and none produces a review, do NOT return an empty/clean result (empty p1/p2 ` +
      `reads as a clean pass) — return a single P1 "NO REVIEWER AVAILABLE: all reviewers out of quota/auth — code ` +
      `is UNREVIEWED, do not merge" so it surfaces as a blocker. Otherwise return the structured result from the ` +
      `reviewer that ran.`,
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
