export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially — each impl/fix delegated to the Cursor agent CLI (headless -p --force: auto-routed model, Cursor codebase index, writes + commits), gate each commit on a review loop, then gate the whole branch vs main — review is a separate read-only pass (agent -p --trust: investigates via git/reads but applies no edits)',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a review gate per commit plus a final branch-vs-main gate',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   goal?, phaseIntent?,        // bigger-picture context prepended to each item's impl prompt
//   reviewBase='main',          // the final branch review compares the branch against this
//   maxRounds=7,                // maxRounds = per-commit rounds; the final branch gate uses BRANCH_MAX
//   items: [{ label, prompt, gate }]   // gate = the runnable check (lint/typecheck/test) the commit must pass
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

// Backend: Cursor's `agent` CLI, headless. ONE binary for both roles — impl/fix run it WRITE-capable
// (-p --force: Cursor auto-routes a model, edits files, and makes the git commit), review runs it
// READ-ONLY (-p --trust: it investigates via git/reads but, with no --force, edits are only proposed,
// never applied — our read-only enforcement). No -m/--model: Cursor auto-routes and uses its codebase
// index for context. --output-format defaults to text (final answer only) so there is no --json
// event-stream bloat; we still redirect to a temp file and tail it. Absolute path: the shell doesn't
// source ~/.zshrc. --trust is required even read-only — headless aborts on an untrusted workspace.
const AGENT = '/Users/mradul/.local/bin/agent'

// WRITE/ACT: feed <taskfile> to the agent as its prompt, redirect to <out> and tail it. "$(cat ...)"
// passes arbitrary task text (backticks/$/quotes/newlines) as one arg the shell does not re-interpret.
const implCmd = (taskfile, out) =>
  `${AGENT} -p --force "$(cat ${taskfile})" > ${out} 2>&1; tail -n 120 ${out}`
// READ-ONLY (review): -p --trust lets it investigate (git, reads) but, with no --force, edits stay
// proposed-only. <prompt> is backtick/$/quote-free (see `p` below) so it embeds safely.
const reviewCmd = (prompt, out) =>
  `${AGENT} -p --trust "${prompt}" > ${out} 2>&1; tail -n 120 ${out}`

const DELEGATE = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'model', 'detail'],
  properties: {
    committed: { type: 'boolean' },
    model: { type: 'string' },
    detail: { type: 'string' },
  },
}

// Delegate ONE implementation/fix task to the Cursor agent CLI (headless, write-capable). It writes the
// task to a temp file (safe quoting), runs the single agent command, and reports back. A run that
// completes — commit or not — is the agent's turn; the gate/fix loop handles a no-commit run.
const delegate = (task, label) => {
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const taskfile = `/tmp/gpe-task-${slug}.txt`
  const out = `/tmp/gpe-out-${slug}.txt`
  return agent(
    `You are delegating ONE implementation/fix task on git branch \`${branch}\` to the Cursor agent CLI — ` +
      `do NOT do the coding yourself. First write the task (given at the END of this message) VERBATIM to ` +
      `${taskfile} using the Write tool, so backticks/$/quotes/newlines are preserved exactly. Then run this ` +
      `command EXACTLY as written (absolute path — the shell does not source ~/.zshrc), with Bash timeout ` +
      `600000 ms. It is agentic and WRITE-CAPABLE (-p --force: Cursor auto-routes a model, edits files, and ` +
      `makes the git commit itself). Output is the final answer only — read ONLY the tail; do NOT pass --json.\n\n` +
      `  ${implCmd(taskfile, out)}\n\n` +
      `Then decide:\n` +
      `• It completed AND left a NEW commit at HEAD (verify with git log --oneline -1 / that HEAD advanced) → ` +
      `return { committed:true, model:"cursor-agent", detail:<short summary + commit subject> }.\n` +
      `• It RAN but left NO new commit → return { committed:false, model:"cursor-agent", detail:<tail> } ` +
      `(the gate/fix loop handles it).\n` +
      `• It could NOT run — connection lost / "exceeded max retries" / out of quota / auth error → ` +
      `return { committed:false, model:"none", detail:"agent unavailable: <reason> — item left for retry" }.` +
      `\n\n--- TASK (write this verbatim to ${taskfile}) ---\n${task}`,
    { label, phase: phaseTitle, schema: DELEGATE }
  )
}

// Self-contained impl instructions handed to the delegated coding agent for one item.
const implTask = (item) =>
  `${contextBlock}You are working on git branch \`${branch}\`. Implement EXACTLY this one checklist item, nothing else:\n\n${item.prompt}\n\n` +
  `Follow repo conventions (TDD where adding behavior). Be lazy in the disciplined sense: write the ` +
  `SHORTEST diff that works — prefer the stdlib, a native platform feature, or an already-installed ` +
  `dependency over new code; deletion over addition; no speculative abstraction, config, or scaffolding ` +
  `for a need that is not here yet. Mark a deliberate shortcut with a brief comment naming its ceiling. ` +
  `Never simplify away input validation at trust boundaries, error handling, security, or accessibility. ` +
  `If this item builds or reshapes user-facing UI, make it distinctive rather than templated: avoid the ` +
  `default AI looks (cream + serif + terracotta; near-black + acid-green; generic hairline broadsheet), ` +
  `choose typography and ONE signature element deliberately and keep everything around it quiet, respect ` +
  `a quality floor (responsive, visible keyboard focus, prefers-reduced-motion), and write UI copy from ` +
  `the user's side in active voice with the same action name through a flow ("Publish" then "Published"). ` +
  `When the item is done AND its named gate is green ` +
  `(run the specific check it names — the project's lint/typecheck/test command), \`git add\` + \`git commit\` ` +
  `with a conventional message + the repo's Co-Authored-By trailer. If already satisfied, make no commit.`

// The reviewer is a SEPARATE read-only pass over the diff (the Cursor agent run with no --force, so it
// can investigate but not apply edits). Not the same invocation that wrote the code; one reviewer per review.
const reviewAgent = (target, label) => {
  const scopeMd =
    target === 'branch'
      ? `this branch vs \`${reviewBase}\` (the changes in \`git diff ${reviewBase}...HEAD\`)`
      : `the latest commit (the changes in \`git diff HEAD~1 HEAD\`)`
  const ref = target === 'branch' ? `${reviewBase}...HEAD` : 'HEAD~1 HEAD'
  // Unique per-review temp path so concurrent plan runs can't cross-read each other's output
  // (a stale/partial read could otherwise look like a clean review). slug from the review label.
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const out = `/tmp/gpe-${slug}.txt`
  // Agentic review instruction. NOTE: kept free of backticks, $ and double-quotes so it embeds safely
  // inside the double-quoted shell arg below (no command substitution).
  const p =
    `Review ${target === 'branch' ? `this branch against ${reviewBase}` : 'the latest commit'} for ` +
    `correctness. Run git (e.g. git diff ${ref}) and read the surrounding code as needed — investigate, ` +
    `do not just skim. List P1 (must-fix: bug, regression, security, data loss) and P2 (correctness risk, ` +
    `missing edge case) issues with file:line. Ignore style/nits. Make NO edits.`
  return agent(
    `On branch \`${branch}\`, review ${scopeMd}. Run this command EXACTLY as written (absolute path — the ` +
      `shell does not source ~/.zshrc), with Bash timeout 600000 ms, then WAIT for it to finish:\n\n` +
      `  ${reviewCmd(p, out)}\n\n` +
      `It is the Cursor agent headless and READ-ONLY (-p --trust, no --force: it investigates via git/reads ` +
      `but cannot apply edits). It auto-routes a model and uses Cursor's codebase index — let it explore; do ` +
      `not pre-dump the diff. Output is the final answer only — read ONLY the tail; do NOT use --json. ` +
      `Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) and P2 (should-fix: ` +
      `correctness risk, missing edge case). Ignore P3/nits/style. Edit nothing. If the agent could NOT run ` +
      `(connection lost / "exceeded max retries" / out of quota / auth) and produced no review, do NOT return ` +
      `an empty/clean result (empty p1/p2 reads as a clean pass) — return a single P1 "NO REVIEWER AVAILABLE: ` +
      `agent unavailable — code is UNREVIEWED, do not merge" so it surfaces as a blocker. Otherwise return the ` +
      `structured result.`,
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
  const impl = await delegate(implTask(item), `impl:${item.label}`)
  if (!impl?.committed) log(`⚠ ${item.label}: impl agent left no commit — ${impl?.detail || 'unknown'} (gate will catch it)`)

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
        await delegate(
          `On branch \`${branch}\`, the gate for "${item.label}" is RED:\n\n${g?.detail || 'gate command failed'}\n\n` +
            `Fix the code so the gate (${item.gate}) passes green — no suppression, no skipping tests — then commit. Change only what's needed.`,
          `gatefix:${item.label}#${round}`
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
    await delegate(
      `On branch \`${branch}\`, the review flagged these on "${item.label}". Fix ALL properly (no suppression), re-run the item's gate green, then commit:\n\n` +
        blockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      `fix:${item.label}#${round}`
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
    await delegate(
      `On branch \`${branch}\`, the full-branch review vs \`${reviewBase}\` flagged these. Fix ALL properly (no suppression), ` +
        `re-run the affected gates green, then commit:\n\n` +
        branchBlockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      `branchfix#${round}`
    )
  }
}

return { branch, itemsDone: items.length, unresolved, branchUnresolved: branchBlockers }
