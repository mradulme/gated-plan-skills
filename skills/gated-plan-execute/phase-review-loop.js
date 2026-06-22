export const meta = {
  name: 'phase-review-loop',
  description: 'Branch from base, do each checklist item sequentially — each impl/fix delegated to a POOLED model CLI chosen by skills/_shared/pool.mjs (glm/minimax/kimi/codex/cursor, fair-warmup then best value-for-money; write-capable: edits + commits), gate each commit on a review loop, then gate the whole branch vs main — review is a separate read-only pass run by a DIFFERENT pooled model than the last author. Every run is scored to ~/.gated-plan/events.jsonl. When the pool stalls on an item (fix round >= fallbackAfter) or all candidates are unavailable, a Claude Code native subagent (last resort) takes one direct fix shot and hands back',
  whenToUse: 'Invoked by the execute-gated-plan skill to run one phase of a commit-by-commit plan doc with a review gate per commit plus a final branch-vs-main gate',
  phases: [{ title: 'Phase' }],
}

// args = {
//   phaseTitle, branch, base='release',
//   goal?, phaseIntent?,        // bigger-picture context prepended to each item's impl prompt
//   reviewBase='main',          // the final branch review compares the branch against this
//   maxRounds=7,                // maxRounds = per-commit rounds; the final branch gate uses BRANCH_MAX
//   fallbackAfter=3,            // once a fix round reaches this number the pool is deemed stuck and a
//                               // Claude Code NATIVE subagent (last resort) takes one direct fix shot
//                               // instead (rounds 1..fallbackAfter-1 stay with the pool); native also
//                               // steps in immediately whenever the whole pool reports unavailable
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
  fallbackAfter = 3,
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
  required: ['p1', 'p2', 'summary', 'model'],
  properties: {
    p1: { type: 'array', items: { type: 'string' } },
    p2: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    model: { type: 'string' },
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

// Backend: a POOL of model CLIs, routed by skills/_shared/pool.mjs (the on-disk source of truth — the
// Workflow sandbox has no fs/require, so the agent() subagents below shell out to it). For each task it
// hands back ONE runnable command (the top pick) plus the ranked fallback ids; the subagent runs that
// single command, and only on unavailability re-routes with --exclude to get the next single command,
// then records the outcome. One write command is ever live, so a task can't fan out to several models
// at once. impl/fix get WRITE-capable commands (edit + commit),
// review gets READ-ONLY commands (investigate via git/reads, no edits). claude is NOT in the pool — it is
// the native last resort (nativeFix) so it can never skew the value rankings. Absolute path: the shell
// doesn't source ~/.zshrc, and pool.mjs emits absolute/ config-dir invocations for the same reason.
const POOL = '/Users/mradul/git/gated-plan-skills/skills/_shared/pool.mjs'

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

// Delegate ONE implementation/fix task to a POOLED write-capable model CLI. The subagent writes the task
// to a temp file (safe quoting), asks pool.mjs to route, runs the ONE chosen command and waits (only
// re-routing with --exclude to a different model if that one was unavailable — never two at once),
// records the outcome, and reports back. A run that completes —
// commit or not — is that model's turn; the gate/fix loop handles a no-commit run. `role` is implement
// or fix (both 'code' bucket); `exclude` keeps a model out of contention if the caller wants to.
const delegate = (task, label, role = 'implement', exclude = []) => {
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const taskfile = `.gated-plan-tmp/gpe-task-${slug}.txt`
  const out = `.gated-plan-tmp/gpe-out-${slug}.txt`
  const ex = exclude.length ? ` --exclude ${exclude.join(',')}` : ''
  return agent(
    `You are delegating ONE ${role} task on git branch \`${branch}\` to a pooled model CLI — do NOT code it ` +
      `yourself. EXACTLY ONE write-capable model may run for this task: run it, WAIT for it, and only try ` +
      `another model if the first never ran (UNAVAILABLE). NEVER run two model commands for this task, and ` +
      `NEVER start another while one is still running or has already succeeded — that would corrupt the branch.\n` +
      `Work these steps, each with Bash timeout 600000 ms (absolute paths — the shell does not source ~/.zshrc):\n` +
      `1. Write the task (given at the END, after the marker) VERBATIM to ${taskfile} with the Write tool ` +
      `(preserve backticks/$/quotes/newlines).\n` +
      `2. Route: \`node ${POOL} route --role ${role} --file ${taskfile} --out ${out}${ex}\`. It prints ` +
      `{chosen:{id,command}, fallbackIds:[...]} — chosen is the ONE model to run (null if none eligible).\n` +
      `3. Run chosen.command EXACTLY as printed and WAIT for it to finish — nothing else. It is WRITE-CAPABLE ` +
      `(edits files + makes the git commit). Read ONLY the tail of ${out}.\n` +
      `4. ONLY if it reports UNAVAILABLE (connection lost / exceeded max retries / out of quota / auth error / ` +
      `empty output — i.e. it never actually ran) do you try the next model: re-route excluding every id tried ` +
      `so far — \`node ${POOL} route --role ${role} --file ${taskfile} --out ${out} --exclude <tried-ids,comma-sep>\`${ex ? ` (keep the pre-excluded ${exclude.join(',')} too)` : ''} — then run the new chosen.command (step 3). Repeat until one runs or chosen is null. If chosen is null, the model is "none".\n` +
      `5. Record: \`node ${POOL} record --role ${role} --model <id-that-ran> --available <true|false> ` +
      `--committed <true|false>\` (available=false only if every candidate was unavailable; committed=true iff a ` +
      `NEW commit is at HEAD — verify git log --oneline -1 / that HEAD advanced).\n` +
      `6. Return { committed, model:<id-that-ran, or "none" if all unavailable>, detail:<short summary + commit ` +
      `subject, or the failure reason> }.` +
      `\n\n--- TASK (write this verbatim to ${taskfile}) ---\n${task}`,
    { label, phase: phaseTitle, schema: DELEGATE }
  )
}

// Shared coding discipline — used by both the pooled impl task and the native-Claude fallback so the
// two solvers can't drift. Same diff philosophy, safety floor, and UI-quality bar for either author.
const DISCIPLINE =
  `Follow repo conventions (TDD where adding behavior). Be lazy in the disciplined sense: write the ` +
  `SHORTEST diff that works — prefer the stdlib, a native platform feature, or an already-installed ` +
  `dependency over new code; deletion over addition; no speculative abstraction, config, or scaffolding ` +
  `for a need that is not here yet. Mark a deliberate shortcut with a brief comment naming its ceiling. ` +
  `Never simplify away input validation at trust boundaries, error handling, security, or accessibility. ` +
  `If this builds or reshapes user-facing UI, make it distinctive rather than templated: avoid the ` +
  `default AI looks (cream + serif + terracotta; near-black + acid-green; generic hairline broadsheet), ` +
  `choose typography and ONE signature element deliberately and keep everything around it quiet, respect ` +
  `a quality floor (responsive, visible keyboard focus, prefers-reduced-motion), and write UI copy from ` +
  `the user's side in active voice with the same action name through a flow ("Publish" then "Published").`

// Self-contained impl instructions handed to the delegated coding agent for one item.
const implTask = (item) =>
  `${contextBlock}You are working on git branch \`${branch}\`. Implement EXACTLY this one checklist item, nothing else:\n\n${item.prompt}\n\n` +
  `${DISCIPLINE} When the item is done AND its named gate is green ` +
  `(run the specific check it names — the project's lint/typecheck/test command), \`git add\` + \`git commit\` ` +
  `with a conventional message + the repo's Co-Authored-By trailer. If already satisfied, make no commit.`

// NATIVE fallback solver (last resort): a Claude Code subagent that does the coding ITSELF
// (Edit/Write/Bash) — NO pool/CLI call. Used when the pool has stalled on an item (round >=
// fallbackAfter) or the whole pool is unavailable. It lacks a prebuilt codebase index, so the handed-in
// <task> must already carry the gate output / review blockers (it does — every fix call site embeds
// them). Returns the SAME DELEGATE schema as `delegate` so call sites are uniform. ONE focused attempt,
// then it hands back to the loop (which re-runs the gate and a pooled review next round) — no internal loop.
const nativeFix = (task, label) =>
  agent(
    `The pooled model CLIs have been unable to resolve this on git branch \`${branch}\`, so YOU are the ` +
      `LAST-RESORT fallback solver: implement the fix DIRECTLY with your own Edit/Write/Bash tools — do NOT ` +
      `route through pool.mjs or any model CLI. You do not have a prebuilt codebase index, so read the files ` +
      `named in the task yourself. Make exactly ONE focused fix attempt — do not loop. ${DISCIPLINE} Then ` +
      `re-run the item's gate and, only if it is green, \`git add\` + \`git commit\` with a conventional ` +
      `message + the repo's Co-Authored-By trailer. Finally record it: ` +
      `\`node ${POOL} record --role fix --model claude-native --available true --committed <true|false>\`. ` +
      `Report { committed (did HEAD advance with a new commit?), model:"claude-native", ` +
      `detail:<short summary + commit subject, or why no commit> }.` +
      `\n\n--- TASK ---\n${task}`,
    { label: `native-${label}`, phase: phaseTitle, schema: DELEGATE }
  )

// Route ONE fix attempt to the right solver. The pool is primary; the Claude native fallback (last
// resort) takes a single shot when the item is stuck (round >= fallbackAfter) or when the whole pool is
// unavailable. Either way it is one attempt handed back to the loop, which re-gates and re-reviews next
// round. Returns the DELEGATE result so the caller can track who last authored the code.
const fixAttempt = async (task, label, round) => {
  if (round >= fallbackAfter) {
    log(`↯ ${label}: pool stuck at round ${round} — native Claude fallback (one shot)`)
    return nativeFix(task, label)
  }
  const r = await delegate(task, label, 'fix')
  if (r?.model === 'none') {
    log(`↯ ${label}: whole model pool unavailable — native Claude fallback (one shot)`)
    return nativeFix(task, label)
  }
  return r
}

// The reviewer is a SEPARATE read-only pass over the diff, run by a POOLED model — and `exclude` keeps
// it from being whoever last authored the code, so implementer ≠ reviewer holds even after fixes.
const reviewAgent = (target, label, exclude = []) => {
  const scopeMd =
    target === 'branch'
      ? `this branch vs \`${reviewBase}\` (the changes in \`git diff ${reviewBase}...HEAD\`)`
      : `the latest commit (the changes in \`git diff HEAD~1 HEAD\`)`
  const ref = target === 'branch' ? `${reviewBase}...HEAD` : 'HEAD~1 HEAD'
  // Unique per-review temp paths so concurrent plan runs can't cross-read each other's output
  // (a stale/partial read could otherwise look like a clean review). slug from the review label.
  const slug = label.replace(/[^a-z0-9]+/gi, '-')
  const pf = `.gated-plan-tmp/gpe-rev-${slug}.txt`
  const out = `.gated-plan-tmp/gpe-${slug}.txt`
  const ex = exclude.length ? ` --exclude ${exclude.join(',')}` : ''
  // Review instruction handed to the pooled reviewer (file-fed via "$(cat ...)", so backticks/$ are fine).
  const p =
    `Review ${target === 'branch' ? `this branch against ${reviewBase}` : 'the latest commit'} for ` +
    `correctness. Run git (e.g. git diff ${ref}) and read the surrounding code as needed — investigate, ` +
    `do not just skim. List P1 (must-fix: bug, regression, security, data loss) and P2 (correctness risk, ` +
    `missing edge case) issues with file:line. Ignore style/nits. Make NO edits.`
  return agent(
    `On branch \`${branch}\`, review ${scopeMd} using a pooled READ-ONLY model — run EXACTLY ONE reviewer; ` +
      `only try another if the first never ran (UNAVAILABLE). Steps, each Bash timeout 600000 ms (absolute ` +
      `paths — the shell does not source ~/.zshrc):\n` +
      `1. Write the review instruction (given at the END, after the marker) VERBATIM to ${pf} with the Write tool.\n` +
      `2. Route a reviewer DIFFERENT from the implementer: \`node ${POOL} route --role review --file ${pf} ` +
      `--out ${out}${ex}\`. It prints {chosen:{id,command}, fallbackIds:[...]} — chosen is the ONE reviewer to run.\n` +
      `3. Run chosen.command EXACTLY as printed; WAIT for it to finish — nothing else. It is READ-ONLY ` +
      `(investigates via git/reads, applies no edits). Read ONLY the tail of ${out}.\n` +
      `4. ONLY if it reports UNAVAILABLE (connection lost / exceeded max retries / out of quota / auth / empty ` +
      `output) do you try the next: re-route excluding every id tried so far — \`node ${POOL} route --role ` +
      `review --file ${pf} --out ${out} --exclude <tried-ids,comma-sep>\`${ex ? ` (keep the pre-excluded ${exclude.join(',')} too)` : ''} — then run the new chosen.command. Repeat until one runs or chosen is null.\n` +
      `5. Record: \`node ${POOL} record --role review --model <id-that-ran> --available <true|false> ` +
      `--p1 <count> --p2 <count>\`.\n` +
      `6. Classify P1 (must-fix: real bug, regression, security, data loss, broken gate) and P2 (should-fix: ` +
      `correctness risk, missing edge case). Ignore P3/nits/style. If EVERY candidate was unavailable and no ` +
      `review was produced, do NOT return empty p1/p2 (an empty result reads as a clean pass) — record ` +
      `--available false and return a single P1 "NO REVIEWER AVAILABLE: code is UNREVIEWED, do not merge". ` +
      `Return { p1, p2, summary, model:<id-that-ran, or "none"> }.` +
      `\n\n--- REVIEW INSTRUCTION (write this verbatim to ${pf}) ---\n${p}`,
    { label, phase: phaseTitle, schema: REVIEW }
  )
}

// Record ONE quality datapoint via pool.mjs (rounds-to-clean is the key "how good was the first cut"
// signal, attributed to the initial implementer). A tiny dedicated subagent — the Workflow sandbox can't
// touch the filesystem itself. Skipped for an unknown/none author (nothing meaningful to score).
const REC = { type: 'object', additionalProperties: false, required: ['done'], properties: { done: { type: 'boolean' } } }
const recordOutcome = (model, fields, label) => {
  if (!model || model === 'none') return Promise.resolve({ done: false })
  return agent(
    `From the repo root, run this ONE command and nothing else, then return {done:true}:\n` +
      `  node ${POOL} record --role implement --model ${model} ${fields}`,
    { label: `rec:${label}`, phase: phaseTitle, schema: REC }
  )
}

phase(phaseTitle)

await agent(
  `Run from the repo root: if branch \`${branch}\` exists check it out, else \`git checkout -b ${branch} ${base}\`. Print \`git status -sb\`. Change no files.`,
  { label: `branch:${branch}`, phase: phaseTitle }
)

const unresolved = []
// Who last authored code on the branch — the reviewer is always routed to a DIFFERENT model so
// implementer ≠ reviewer holds even after fixes. Persists across items into the final branch gate.
let lastAuthor = ''

for (const item of items) {
  let impl = await delegate(implTask(item), `impl:${item.label}`)
  if (impl?.model === 'none') {
    log(`↯ ${item.label}: whole model pool unavailable for initial impl — native Claude fallback`)
    impl = await nativeFix(implTask(item), `impl:${item.label}`)
  }
  if (!impl?.committed) log(`⚠ ${item.label}: impl agent left no commit — ${impl?.detail || 'unknown'} (gate will catch it)`)
  // The initial implementer carries the rounds-to-clean quality score; lastAuthor tracks the most
  // recent code author for reviewer exclusion (the native fallback authors as "claude-native").
  const implementer = impl?.model && impl.model !== 'none' ? impl.model : 'claude-native'
  lastAuthor = implementer

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
        const gf = await fixAttempt(
          `On branch \`${branch}\`, the gate for "${item.label}" is RED:\n\n${g?.detail || 'gate command failed'}\n\n` +
            `Fix the code so the gate (${item.gate}) passes green — no suppression, no skipping tests — then commit. Change only what's needed.`,
          `gatefix:${item.label}#${round}`,
          round
        )
        if (gf?.model && gf.model !== 'none') lastAuthor = gf.model
        continue // re-verify the gate next round; review does not run on a red gate
      }
      gateRed = false
    }

    const review = await reviewAgent('commit', `review:${item.label}#${round}`, [lastAuthor])
    blockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!blockers.length) {
      log(`✓ ${item.label}: gate green + review clean (round ${round}) — impl by ${implementer}`)
      await recordOutcome(implementer, `--available true --committed true --rounds ${round} --stuck false`, `clean:${item.label}`)
      break
    }
    log(`↻ ${item.label}: ${blockers.length} blocker(s) round ${round} — fixing`)
    const rf = await fixAttempt(
      `On branch \`${branch}\`, the review flagged these on "${item.label}". Fix ALL properly (no suppression), re-run the item's gate green, then commit:\n\n` +
        blockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      `fix:${item.label}#${round}`,
      round
    )
    if (rf?.model && rf.model !== 'none') lastAuthor = rf.model
  }
  if (gateRed || blockers.length) {
    // Item never went clean — score the implementer's first cut as stuck so a model that repeatedly
    // can't be brought green is penalised, not silently dropped.
    await recordOutcome(implementer, `--available true --committed ${!!impl?.committed} --rounds ${maxRounds} --stuck true`, `stuck:${item.label}`)
    if (gateRed) unresolved.push({ item: item.label, blockers: [`gate never green within ${maxRounds} rounds: ${item.gate}`] })
    else unresolved.push({ item: item.label, blockers })
  }
}

// Final gate: review the WHOLE branch against reviewBase to catch cross-commit interactions the
// per-commit gates can't see. Loop-fix like the per-commit gate, then hand back for the merge decision.
let branchBlockers = []
{
  let round = 0
  while (round < BRANCH_MAX) {
    round++
    const review = await reviewAgent('branch', `branch-review#${round}`, [lastAuthor])
    branchBlockers = [...(review?.p1 || []), ...(review?.p2 || [])]
    if (!branchBlockers.length) {
      log(`✓ branch ${branch}: clean vs ${reviewBase} (round ${round})`)
      break
    }
    log(`↻ branch ${branch}: ${branchBlockers.length} blocker(s) round ${round} — fixing`)
    // Only BRANCH_MAX (3) rounds here, so the round-based threshold rarely trips on its own; engage the
    // native fallback on the LAST branch round (or on whole-pool unavailability, handled in fixAttempt).
    const bf = await fixAttempt(
      `On branch \`${branch}\`, the full-branch review vs \`${reviewBase}\` flagged these. Fix ALL properly (no suppression), ` +
        `re-run the affected gates green, then commit:\n\n` +
        branchBlockers.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      `branchfix#${round}`,
      round === BRANCH_MAX ? fallbackAfter : 0
    )
    if (bf?.model && bf.model !== 'none') lastAuthor = bf.model
  }
}

return { branch, itemsDone: items.length, unresolved, branchUnresolved: branchBlockers }
