export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially — each impl/fix delegated to the difficulty-matched coding agent (intelligence ladder kimi → minimax → sonnet → glm → gpt → opus, via cline act-mode or claude write-mode; on a quota/auth miss it falls through to the next model in the same stage so an unavailable model never blocks the item), gate each commit on a review loop, then gate the whole branch vs main — the reviewer is difficulty-matched one tier ABOVE the implementer on the same ladder (read-only: cline plan-mode, claude allowedTools whitelist), with the same quota/auth fallback',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a review gate per commit plus a final branch-vs-main gate',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   goal?, phaseIntent?,        // bigger-picture context prepended to each item's impl prompt
//   reviewBase='main',          // the final branch review compares the branch against this
//   maxRounds=7,                // maxRounds = per-commit rounds; the final branch gate uses BRANCH_MAX
//   items: [{ label, prompt, gate, difficulty }]   // gate = the runnable check (lint/typecheck/test);
//                                                  // difficulty = 1-5 (orchestrator-rated), picks the impl model (default 3)
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

// Reviewer = the SAME ladder as impl (below), invoked READ-ONLY and difficulty-matched ONE TIER ABOVE
// the model that implemented the item — so a smarter model reviews and it is never the author. Exactly
// ONE reviewer runs per review; the next is tried ONLY if the current can't review. Not parallel, not
// stacked. All are AGENTIC — each explores the repo with its own tools (runs git, reads files); we never
// hand it a pre-dumped diff. All assumed preconfigured (cline providers logged in / claude logged in —
// never set keys/models here). Each prints findings as text, so one classifier handles all. The chain
// falls through to the next ladder model (candidatesFor: chosen tier, then up, then down) ONLY when the
// current one can't review because it's out of credits/quota/rate-limit/auth (for cline this often shows
// up as an unauthenticated / not-logged-in / expired-token error — treat that as quota). cline `-p` is
// PLAN MODE: it investigates but cannot edit (our read-only enforcement); claude `-p` is print mode, its
// read-only coming from --allowedTools. Absolute paths: the review shell doesn't source ~/.zshrc. No
// --json (it re-emits every event — token bloat); redirect to a temp file and tail it. See reviewCmd /
// reviewAgent below.
const CLINE = '/opt/homebrew/bin/cline'
const CLAUDE = '$HOME/.local/bin/claude'

// Impl/fix DELEGATION ladder — tiers ordered by ASCENDING INTELLIGENCE SCORE. The orchestrator rates
// each item's difficulty 1-5 and the matching tier's coding agent does the work AND the git commit,
// instead of the workflow re-spawning its own model on everything. The matched tier is the PRIMARY; if
// it is unavailable (quota/auth) the delegate falls through to the next ladder model in the SAME stage
// (see candidatesFor / delegate below). cline runs in ACT mode (no -p) where --auto-approve defaults
// true, so it edits files and runs git autonomously; claude runs write-capable via
// --permission-mode bypassPermissions. Same no-`--json`, redirect-and-tail discipline as the review
// chain. thinking=high throughout; tiers 3 + 6 are Claude → spend main Claude credits; 1/2/4/5 use cline
// provider plans (each with an EXPLICIT -P provider — never the bare default `cline` provider):
const LADDER = [
  { tier: 1, name: 'kimi-k2.7', score: 42, kind: 'cline', args: '-P moonshot -m kimi-k2.7-code' },
  { tier: 2, name: 'minimax-m3', score: 44, kind: 'cline', args: '-P minimax -m MiniMax-M3 --thinking high' },
  { tier: 3, name: 'claude-sonnet-4-6', score: 47, kind: 'claude', model: 'claude-sonnet-4-6' },
  { tier: 4, name: 'glm-5.2', score: 51, kind: 'cline', args: '-P zai-coding-plan -m glm-5.2 --thinking high' },
  { tier: 5, name: 'gpt-5.5', score: 54, kind: 'cline', args: '-P openai-codex -m gpt-5.5 --thinking high' },
  { tier: 6, name: 'claude-opus-4-8', score: 56, kind: 'claude', model: 'claude-opus-4-8' },
]
const clampTier = (t) => Math.max(1, Math.min(LADDER.length, Math.round(t) || 1))
// Difficulty 1-5 → impl tier on the score ladder, 1:1 onto the first five tiers (kimi, minimax, sonnet,
// glm, gpt). Opus (tier 6) is reached as a primary only to REVIEW difficulty-5 items (review = impl+1,
// below) and as the fix/branch escalation ceiling. No default model — the orchestrator always rates
// difficulty; the clamp only guards a missing/garbage value.
const DIFF_TIER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }
const tierFor = (difficulty) => DIFF_TIER[Math.max(1, Math.min(5, Math.round(difficulty) || 3))]
// Difficulty picks the PRIMARY model; the rest of the ladder are fallbacks tried (in the same stage)
// ONLY when the current model is unavailable (out of quota/auth) — never to "second-guess" a model that
// actually ran. Order: chosen tier first, then higher tiers (more capable) ascending, then lower tiers
// descending — so an unavailable model degrades to the nearest equal-or-stronger model first, and an
// out-of-quota model can never silently block an item.
const candidatesFor = (tier) => {
  const t = clampTier(tier)
  const up = []
  for (let i = t + 1; i <= LADDER.length; i++) up.push(LADDER[i - 1])
  const down = []
  for (let i = t - 1; i >= 1; i--) down.push(LADDER[i - 1])
  return [LADDER[t - 1], ...up, ...down]
}
// WRITE/ACT mode: feed <taskfile> to a candidate as its prompt, redirect to <out> and tail it.
// "$(cat ...)" passes arbitrary task text (backticks/$/quotes/newlines) as one arg the shell does not
// re-interpret. cline ACT mode (no -p) auto-approves its tools; claude writes via bypassPermissions.
const candidateCmd = (m, taskfile, out) =>
  m.kind === 'cline'
    ? `${CLINE} ${m.args} "$(cat ${taskfile})" > ${out} 2>&1; tail -n 120 ${out}`
    : `${CLAUDE} --model ${m.model} -p "$(cat ${taskfile})" --permission-mode bypassPermissions > ${out} 2>&1; tail -n 120 ${out}`
// READ-ONLY mode (review): same candidate, but it can investigate yet not edit. cline -p is PLAN mode;
// claude is held read-only by an --allowedTools whitelist. <prompt> is backtick/$/quote-free (see `p`
// below) so it embeds safely in the double-quoted shell arg. cline redirects+tails; claude prints direct.
const reviewCmd = (m, prompt, out) =>
  m.kind === 'cline'
    ? `${CLINE} -p ${m.args} "${prompt}" > ${out} 2>&1; tail -n 120 ${out}`
    : `${CLAUDE} -p "${prompt}" --model ${m.model} --allowedTools "Bash(git:*)" "Read" "Grep" "Glob"`

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

// Delegate ONE implementation/fix task to the difficulty-matched coding agent, with the rest of the
// ladder as quota/auth fallbacks. It writes the task to a temp file (safe quoting), then tries the
// candidates STRICTLY ONE AT A TIME in order, advancing to the next ONLY when the current model is
// UNAVAILABLE (out of quota/auth). A model that actually RAN — whether or not it committed — ends the
// chain (a no-commit run is a real attempt the gate/fix loop handles; we do not re-run on another model).
const delegate = (task, tier, label) => {
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const taskfile = `/tmp/gpe-task-${slug}.txt`
  const cands = candidatesFor(tier)
  const cmdList = cands
    .map((m, i) => `  ${i + 1}. ${m.name} (tier ${m.tier}): ${candidateCmd(m, taskfile, `/tmp/gpe-out-${slug}-${m.tier}.txt`)}`)
    .join('\n')
  return agent(
    `You are delegating ONE implementation/fix task on git branch \`${branch}\` to a coding-agent CLI — ` +
      `do NOT do the coding yourself. Difficulty picked ${cands[0].name} (tier ${cands[0].tier}) as the ` +
      `PRIMARY model; the others below are fallbacks used ONLY if the current one is UNAVAILABLE. First write ` +
      `the task (given at the END of this message) VERBATIM to ${taskfile} using the Write tool, so ` +
      `backticks/$/quotes/newlines are preserved exactly. Then try the commands below STRICTLY ONE AT A TIME, ` +
      `IN ORDER, each exactly as written (absolute paths — the shell does not source ~/.zshrc), with Bash ` +
      `timeout 600000 ms. Each is agentic and WRITE-CAPABLE (cline in ACT mode auto-approves its tools; claude ` +
      `runs with bypassPermissions) — it edits files and makes the git commit itself. Do NOT pass --json. Read ` +
      `ONLY the tail.\n\n${cmdList}\n\n` +
      `Decide after each command:\n` +
      `• It completed AND left a NEW commit at HEAD (verify with git log --oneline -1 / that HEAD advanced) → ` +
      `STOP, return { committed:true, model:<that model's name>, detail:<short summary + commit subject> }.\n` +
      `• It RAN but left NO new commit → STOP (do NOT try another model — it had its turn; the gate/fix loop ` +
      `handles it), return { committed:false, model:<that model's name>, detail:<tail> }.\n` +
      `• It could NOT run because it is out of credits/quota/rate-limit, OR (for cline) an auth / ` +
      `unauthenticated / not-logged-in / expired-or-invalid-token error (e.g. a single line "error: The usage ` +
      `limit has been reached" or "error: Invalid Authentication", exit 1) → that model is UNAVAILABLE: move ` +
      `to the NEXT command in the list and try again.\n` +
      `If EVERY candidate is unavailable, return { committed:false, model:"none", detail:"all models ` +
      `unavailable: out of quota/auth — item left for retry" }.` +
      `\n\n--- TASK (write this verbatim to ${taskfile}) ---\n${task}`,
    { label, phase: phaseTitle, schema: DELEGATE }
  )
}

// Self-contained impl instructions handed to the delegated coding agent for one item.
const implTask = (item) =>
  `${contextBlock}You are working on git branch \`${branch}\`. Implement EXACTLY this one checklist item, nothing else:\n\n${item.prompt}\n\n` +
  `Follow repo conventions (TDD where adding behavior). When the item is done AND its named gate is green ` +
  `(run the specific check it names — the project's lint/typecheck/test command), \`git add\` + \`git commit\` ` +
  `with a conventional message + the repo's Co-Authored-By trailer. If already satisfied, make no commit.`

// The reviewer is difficulty-matched on the SAME ladder as impl — picked ONE TIER ABOVE the model that
// implemented the item (a smarter model reviews, and it is never the model that wrote the code), capped
// at opus. `tier` is that review tier; candidatesFor(tier) gives the read-only fallback chain (chosen
// tier, then up, then down) used ONLY when the current model is out of quota/auth — not a fixed default.
const reviewAgent = (target, label, tier) => {
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
  const cands = candidatesFor(tier)
  const cmdList = cands
    .map((m, i) => `  ${i + 1}. ${m.name} (tier ${m.tier}): ${reviewCmd(m, p, tmp(m.tier))}`)
    .join('\n')
  return agent(
    `On branch \`${branch}\`, review ${scopeMd}. Difficulty matched ${cands[0].name} (tier ${cands[0].tier}, ` +
      `one tier above the implementer) as the reviewer; the rest below are fallbacks used ONLY if the current ` +
      `one is UNAVAILABLE. Try them STRICTLY ONE AT A TIME, IN ORDER, exactly as written (absolute paths — the ` +
      `shell does not source ~/.zshrc). Run exactly ONE reviewer command per Bash call (Bash timeout 600000 ms), ` +
      `WAIT for it to finish, then decide. NEVER run two reviewers in parallel. Each cline command redirects to ` +
      `its own temp file and tails it: read ONLY that tail (the final findings) — do NOT use --json (it dumps ` +
      `the whole event stream); claude prints its final answer directly, no redirect. cline runs in PLAN MODE ` +
      `(-p) so it investigates but cannot edit; claude is read-only via --allowedTools. Each is agentic — let it ` +
      `explore the repo; do not pre-dump the diff:\n\n${cmdList}\n\n` +
      `Classify the output of the FIRST that produces a review and STOP (do not run the others). ` +
      `Move to the next ONLY if the current one fails because it cannot review — out of credits/quota/rate-limit, ` +
      `OR (for cline) an auth / unauthenticated / not-logged-in / expired-or-invalid-token error, which is how ` +
      `cline surfaces an exhausted plan (observed examples: a single-line "error: The usage limit has been ` +
      `reached" or "error: Invalid Authentication", exit 1). Do NOT fall through because it found issues (that ` +
      `is a valid review) or for any other error. Assume all are configured and logged in — do NOT configure ` +
      `keys/models. Classify into P1 (must-fix: real bug, regression, security, data loss, broken gate) and ` +
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
  const baseTier = tierFor(item.difficulty)
  const reviewTier = clampTier(baseTier + 1) // review one tier above the implementer (never self-review), capped at opus
  let escalations = 0 // each failed round bumps the fix one tier up the ladder (capped at the top tier)
  const fixTier = () => clampTier(baseTier + escalations)

  const impl = await delegate(implTask(item), baseTier, `impl:${item.label}`)
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
        log(`✗ ${item.label}: gate RED round ${round} — fixing before review (tier ${fixTier()})`)
        await delegate(
          `On branch \`${branch}\`, the gate for "${item.label}" is RED:\n\n${g?.detail || 'gate command failed'}\n\n` +
            `Fix the code so the gate (${item.gate}) passes green — no suppression, no skipping tests — then commit. Change only what's needed.`,
          fixTier(),
          `gatefix:${item.label}#${round}`
        )
        escalations++
        continue // re-verify the gate next round; review does not run on a red gate
      }
      gateRed = false
    }

    const review = await reviewAgent('commit', `review:${item.label}#${round}`, reviewTier)
    blockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!blockers.length) {
      log(`✓ ${item.label}: gate green + review clean (round ${round})`)
      break
    }
    log(`↻ ${item.label}: ${blockers.length} blocker(s) round ${round} — fixing (tier ${fixTier()})`)
    await delegate(
      `On branch \`${branch}\`, the review flagged these on "${item.label}". Fix ALL properly (no suppression), re-run the item's gate green, then commit:\n\n` +
        blockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      fixTier(),
      `fix:${item.label}#${round}`
    )
    escalations++
  }
  if (gateRed) unresolved.push({ item: item.label, blockers: [`gate never green within ${maxRounds} rounds: ${item.gate}`] })
  else if (blockers.length) unresolved.push({ item: item.label, blockers })
}

// Final gate: review the WHOLE branch against reviewBase to catch cross-commit interactions the
// per-commit gates can't see. Loop-fix like the per-commit gate, then hand back for the merge decision.
let branchBlockers = []
{
  // Cross-commit fixes are subtle — fix starts near the top of the ladder (max item tier, floored at
  // gpt=5) and escalates to opus across the ≤3 rounds; review runs one tier above that (so opus).
  const branchBase = clampTier(Math.max(5, ...items.map((it) => tierFor(it.difficulty))))
  let round = 0
  while (round < BRANCH_MAX) {
    round++
    const review = await reviewAgent('branch', `branch-review#${round}`, clampTier(branchBase + 1))
    branchBlockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!branchBlockers.length) {
      log(`✓ branch ${branch}: clean vs ${reviewBase} (round ${round})`)
      break
    }
    const tier = clampTier(branchBase + (round - 1))
    log(`↻ branch ${branch}: ${branchBlockers.length} blocker(s) round ${round} — fixing (tier ${tier})`)
    await delegate(
      `On branch \`${branch}\`, the full-branch review vs \`${reviewBase}\` flagged these. Fix ALL properly (no suppression), ` +
        `re-run the affected gates green, then commit:\n\n` +
        branchBlockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      tier,
      `branchfix#${round}`
    )
  }
}

return { branch, itemsDone: items.length, unresolved, branchUnresolved: branchBlockers }
