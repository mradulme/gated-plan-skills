export const meta = {
  name: 'research-panel',
  description:
    'Run a simulated qualitative user-research study of an existing product surface: a lead researcher (this workflow) recruits a panel of user personas — each with a persona + Jobs-To-Be-Done + pain points, and each voiced by a DIFFERENT pooled model CLI chosen by skills/_shared/pool.mjs (glm/minimax/kimi/codex/cursor, read-only — distinct model minds, not one model role-playing all) — who INDEPENDENTLY walk the product through their JTBD, then clusters findings by prevalence × severity into a prioritized cut / keep / improve report that gated-plan-create can consume. Each turn is scored to ~/.gated-plan/events.jsonl. The pooled models inspect source read-only and cannot run the app, so snappiness/aesthetics are inferred hypotheses, flagged for real-user validation.',
  whenToUse:
    'Invoked by the gated-plan-research skill to gather simulated qualitative user feedback on the current product (features, design, aesthetics, snappiness) before deciding what to cut/keep/improve',
  phases: [
    { title: 'Recruit' },
    { title: 'Walkthrough' },
    { title: 'Affinity' },
    { title: 'Prioritize' },
    { title: 'Report' },
  ],
}

// args = { surface, focus=[], artifacts=[], outDir='docs/research', maxPanel=5, rounds=1 }
// args may arrive as an object or, depending on the harness, a JSON string — normalize both.
const _args = typeof args === 'string' ? JSON.parse(args) : args || {}
const { surface, focus = [], artifacts = [], outDir = 'docs/research', maxPanel = 5, rounds = 1 } = _args
if (!surface) throw new Error('args.surface is required (the product / surface to research)')

const slug =
  String(surface).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research'
const reportPath = `${outDir}/${slug}.md`

// ---- Backend: a POOL of read-only model CLIs, routed by skills/_shared/pool.mjs (the on-disk source of
// truth — the Workflow sandbox has no fs/require, so the agent() subagents shell out to it). The lead
// researcher assigns a DISTINCT model to each persona (round-robin over pool.mjs's ordered, warmup/value
// aware id list) so the panel is genuinely different minds, not one model role-playing every user. Each
// session runs `pool.mjs cmd --id <model> --role research` to get its read-only command (may read repo
// files + cited artifacts to ground itself, edits nothing), feeds the prompt via a temp file +
// "$(cat ...)" so backticks/$/quotes/newlines survive, tails the output, and records the turn. The users
// INSPECT source read-only and cannot run the app — so this is heuristic/inspection-based evaluation that
// generates hypotheses, not empirical usability testing. claude is NOT pooled.
const POOL = '/Users/mradul/git/gated-plan-skills/skills/_shared/pool.mjs'

const SPEAK = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'model'],
  properties: { text: { type: 'string' }, model: { type: 'string' } },
}
const LIST = {
  type: 'object',
  additionalProperties: false,
  required: ['ids'],
  properties: { ids: { type: 'array', items: { type: 'string' } } },
}
const RECRUIT = {
  type: 'object',
  additionalProperties: false,
  required: ['researchGoal', 'taskScenarios', 'personas'],
  properties: {
    researchGoal: { type: 'string' },
    taskScenarios: { type: 'array', items: { type: 'string' } },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'segment', 'jtbd', 'context', 'painPoints', 'disposition', 'successCriteria'],
        properties: {
          name: { type: 'string' },
          segment: { type: 'string' },
          jtbd: { type: 'string' },
          context: { type: 'string' },
          painPoints: { type: 'array', items: { type: 'string' } },
          disposition: { type: 'string' },
          successCriteria: { type: 'string' },
        },
      },
    },
  },
}
const THEME = {
  type: 'object',
  additionalProperties: false,
  required: ['theme', 'prevalence', 'severity', 'segments', 'evidence', 'observed'],
  properties: {
    theme: { type: 'string' },
    prevalence: { type: 'integer' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'delight'] },
    segments: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    observed: { type: 'string', enum: ['grounded', 'mixed', 'inferred'] },
  },
}
const AFFINITY = {
  type: 'object',
  additionalProperties: false,
  required: ['panelSize', 'themes', 'delights', 'divergences'],
  properties: {
    panelSize: { type: 'integer' },
    themes: { type: 'array', items: THEME },
    delights: { type: 'array', items: { type: 'string' } },
    divergences: { type: 'array', items: { type: 'string' } },
  },
}
const REFOCUS = {
  type: 'object',
  additionalProperties: false,
  required: ['areas'],
  properties: { areas: { type: 'array', items: { type: 'string' } } },
}
const RECO = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'what', 'why', 'prevalence', 'severity', 'confidence'],
  properties: {
    action: { type: 'string', enum: ['cut', 'keep', 'improve'] },
    what: { type: 'string' },
    why: { type: 'string' },
    prevalence: { type: 'integer' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'delight'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}
const PRIORITIZE = {
  type: 'object',
  additionalProperties: false,
  required: ['cut', 'keep', 'improve'],
  properties: {
    cut: { type: 'array', items: RECO },
    keep: { type: 'array', items: RECO },
    improve: { type: 'array', items: RECO },
  },
}
const FINAL = {
  type: 'object',
  additionalProperties: false,
  required: ['reportPath', 'summary'],
  properties: { reportPath: { type: 'string' }, summary: { type: 'string' } },
}

const focusLine = focus && focus.length ? focus.join(', ') : 'the whole surface'
const artifactsSummary =
  artifacts && artifacts.length
    ? artifacts.map((a) => `- (${a.kind}) ${a.ref}${a.note ? ` — ${a.note}` : ''}`).join('\n')
    : 'none — repo source only'

const renderTasks = (tasks) => (tasks && tasks.length ? tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)')
const personaBlock = (p) =>
  `${p.name} — ${p.segment}.\n` +
  `Job-to-be-done: ${p.jtbd}\n` +
  `Context of use: ${p.context}\n` +
  `Pain points: ${(p.painPoints || []).join('; ')}\n` +
  `Disposition: ${p.disposition}\n` +
  `Success criteria (what "it worked for me" means to you): ${p.successCriteria}`
const renderSessions = (sess) => {
  if (!sess.length) return '(no sessions captured)'
  return sess.map((s) => `### ${s.name} — ${s.segment} [model: ${s.model}]\n${s.text}`).join('\n\n')
}

// Relay ONE user session to that persona's ASSIGNED pooled read-only model. The user speaks IN CHARACTER,
// inspecting source + cited artifacts (cannot run the app). The turn is recorded so research
// participation/availability per model feeds the same scoreboard as impl/review/brainstorm.
const evaluate = (persona, body, label, phaseLabel, model) => {
  const lslug = label.replace(/[^a-z0-9]+/gi, '-')
  const pf = `.gated-plan-tmp/gpr-prompt-${lslug}.txt`
  const out = `.gated-plan-tmp/gpr-out-${lslug}.txt`
  const full =
    `You ARE this simulated user — evaluate fully IN CHARACTER, first person, not a neutral assistant:\n\n${persona}\n\n${body}\n\n` +
    `IMPORTANT — how you evaluate: you are INSPECTING source code (READ-ONLY) plus any supplied artifacts; you CANNOT run the product. ` +
    `Infer the experience from the implementation. For anything you did not directly observe in code/artifacts — ESPECIALLY performance ` +
    `("snappiness") and visual design ("aesthetics") — say so and frame it as a HYPOTHESIS, reasoning FROM the implementation (e.g. "renders ` +
    `the whole list with no virtualization → likely janky at scale"). Only react to features that ACTUALLY exist (cite the file/screen); put ` +
    `unmet needs in your wishlist as gaps — never assert a feature that isn't there. Be candid in character; do not flatter the product.`
  return agent(
    `You are relaying ONE turn of a user-research session to a pooled READ-ONLY model CLI — do NOT answer yourself. ` +
      `Steps (Bash timeout 600000 ms, absolute paths — the shell does not source ~/.zshrc):\n` +
      `1. Write the session prompt (given at the END, after the marker) VERBATIM to ${pf} with the Write tool ` +
      `(preserve backticks/$/quotes/newlines).\n` +
      `2. Get this user's assigned model command: \`node ${POOL} cmd --id ${model} --role research ` +
      `--file ${pf} --out ${out}\`. It prints {id, command}.\n` +
      `3. Run that command EXACTLY as printed. It is READ-ONLY (may read repo files + cited artifacts to ground itself, edits ` +
      `nothing). Read ONLY the tail of ${out}.\n` +
      `4. Record: \`node ${POOL} record --role research --model ${model} --available <true|false>\`.\n` +
      `5. If it produced the user's session → return { text:<the model's full response, verbatim>, ` +
      `model:"${model}" }. If it could NOT run (connection lost / exceeded max retries / out of quota / auth / ` +
      `empty output) → record --available false and return { text:"(no model available for this user this round)", ` +
      `model:"none" }.` +
      `\n\n--- SESSION PROMPT (write this verbatim to ${pf}) ---\n${full}`,
    { label, phase: phaseLabel, schema: SPEAK }
  )
}

// ---- 1. Recruit: the lead researcher frames the study and recruits the panel ----
phase('Recruit')
const study = await agent(
  `You are the LEAD RESEARCHER planning a qualitative user-research study of this product surface:\n\n` +
    `  ${surface}\n  Focus areas: ${focusLine}\n  Supplied artifacts (extra grounding beyond the repo):\n${artifactsSummary}\n\n` +
    `Skim the repo (and any artifacts) READ-ONLY to learn what the product actually does, then do two things.\n` +
    `(1) Define the study: a one-paragraph research goal, and 3–6 concrete TASK SCENARIOS a real user would attempt against THIS product ` +
    `to get their job done (e.g. "sign up and reach first value", "create and share an X"). Derive tasks ONLY from what the repo/artifacts ` +
    `show actually exists — never invent capabilities.\n` +
    `(2) Recruit a panel of 3–${maxPanel} SIMULATED USERS spanning deliberately DIFFERENT segments and Jobs-To-Be-Done (e.g. a first-timer, ` +
    `a power user, an accessibility-constrained user, a skeptical evaluator, a mobile/low-bandwidth user, a domain expert). They are different ` +
    `PEOPLE with different needs — not debaters. For each: name, segment, jtbd ("When ___ I want to ___ so I can ___"), context ` +
    `(device/environment/frequency/constraints), painPoints, disposition (temperament/bias), and successCriteria (what "this worked for me" means to THEM).\n` +
    `Return { researchGoal, taskScenarios:[...], personas:[{name,segment,jtbd,context,painPoints,disposition,successCriteria}] }.`,
  { label: 'recruit', phase: 'Recruit', schema: RECRUIT }
)
const personas = (study.personas || []).slice(0, maxPanel)
if (personas.length < 2) throw new Error('researcher recruited fewer than 2 personas — cannot form a panel')
const researchGoal = study.researchGoal
const taskScenarios = study.taskScenarios || []

// Assign a DISTINCT model to each persona: round-robin over pool.mjs's ordered id list (warmup/value
// aware) so consecutive users get different minds, wrapping if there are more users than models.
const poolIds = await agent(
  `Run this ONE command from the repo root and return its parsed output, nothing else:\n  node ${POOL} list --role research\n` +
    `It prints {ids:[...]}. Return { ids:<that array> }.`,
  { label: 'pool-ids', phase: 'Recruit', schema: LIST }
)
const ids = poolIds?.ids?.length ? poolIds.ids : ['cursor']
personas.forEach((p, i) => {
  p.model = ids[i % ids.length]
})
log(
  `Recruited ${personas.length} users across models [${personas.map((p) => `${p.name}:${p.model}`).join(', ')}]; ` +
    `${taskScenarios.length} task scenario(s)`
)

// ---- 2. Walkthrough: each user independently walks the product through their JTBD (parallel) ----
phase('Walkthrough')
const sessions = []
const walkthroughBody =
  `The product surface under study: ${surface}\nFocus: ${focusLine}\n` +
  `Artifacts you may read & cite (beyond the repo):\n${artifactsSummary}\n\n` +
  `Task scenarios to attempt — walk EACH in first person:\n${renderTasks(taskScenarios)}\n\n` +
  `For each task, narrate where you succeed, hesitate, or get blocked. Then cover, clearly labelled:\n` +
  `- Frictions — each with where + how bad (blocker / major / minor) + whether observed-in-code or inferred\n` +
  `- Delights — what genuinely works for YOUR job\n` +
  `- Feature reactions — useful / confusing / missing for your JTBD\n` +
  `- Perceived snappiness — INFERRED from the implementation; flag as a hypothesis\n` +
  `- Aesthetic / design impression — INFERRED; flag as a hypothesis\n` +
  `- Cut list — features that add no value for you\n` +
  `- Wishlist — unmet needs / gaps (not invented features)\n` +
  `- One memorable first-person quote\n` +
  `End with a line EXACTLY one of: "Verdict: would-use" / "Verdict: would-use-with-changes" / "Verdict: would-not-use".`
const walk = await parallel(
  personas.map((p) => () => evaluate(personaBlock(p), walkthroughBody, `walk-${p.name}`, 'Walkthrough', p.model))
)
personas.forEach((p, i) => {
  if (walk[i]?.text) sessions.push({ name: p.name, segment: p.segment, model: p.model, text: walk[i].text })
})

// ---- 3. Affinity: cluster observations across users into themes with prevalence + severity ----
phase('Affinity')
let affinity = await agent(
  `You are the LEAD RESEARCHER synthesizing the panel. ${personas.length} simulated users INDEPENDENTLY evaluated "${surface}". ` +
    `Their session notes:\n\n${renderSessions(sessions)}\n\n` +
    `Build an AFFINITY MAP: cluster observations ACROSS users into themes. For each theme: prevalence = how many of the ${personas.length} ` +
    `users independently raised it; severity = the worst any assigned (blocker/major/minor, or "delight" for a shared positive); segments = which ` +
    `user segments; evidence = specific quotes/citations (prefer repo-cited); observed = "grounded" if all underlying observations were seen in ` +
    `code/artifacts, "inferred" if none were, else "mixed". DROP any theme that depends on a feature not present in the repo/artifacts. Also list ` +
    `cross-user delights and divergences (where segments disagreed). Return { panelSize, themes:[...], delights:[...], divergences:[...] }.`,
  { label: 'affinity', phase: 'Affinity', schema: AFFINITY }
)

// Optional second, focused look at the most contested/under-explored areas (still independent, not a debate).
if (rounds >= 2 && sessions.length) {
  const refocus = await agent(
    `You are the LEAD RESEARCHER. Given this affinity map:\n\n${JSON.stringify(affinity, null, 2)}\n\n` +
      `Name the 1–2 task scenarios or themes most worth a SECOND, closer look (most contested across segments, or under-explored). ` +
      `Return { areas:[...] }.`,
    { label: 'refocus', phase: 'Affinity', schema: REFOCUS }
  )
  const areas = (refocus?.areas || []).join('; ')
  if (areas) {
    const relookBody =
      `SECOND LOOK. Re-examine specifically: ${areas}\n` +
      `For the product surface: ${surface} (focus: ${focusLine}). Artifacts:\n${artifactsSummary}\n\n` +
      `Go deeper than your first pass on these — concrete frictions, delights, and for each whether it is observed-in-code or inferred. ` +
      `End with your updated "Verdict: ..." line.`
    const relook = await parallel(
      personas.map((p) => () => evaluate(personaBlock(p), relookBody, `relook-${p.name}`, 'Walkthrough', p.model))
    )
    personas.forEach((p, i) => {
      if (relook[i]?.text) sessions.push({ name: p.name, segment: p.segment, model: p.model, text: relook[i].text })
    })
    affinity = await agent(
      `You are the LEAD RESEARCHER. Re-build the AFFINITY MAP now including the second-look sessions. All session notes:\n\n` +
        `${renderSessions(sessions)}\n\n` +
        `Same rules: prevalence = # of the ${personas.length} users who independently raised it; severity = worst assigned (or "delight"); ` +
        `segments; evidence; observed = grounded/inferred/mixed; drop themes depending on features not present. ` +
        `Return { panelSize, themes:[...], delights:[...], divergences:[...] }.`,
      { label: 'affinity-2', phase: 'Affinity', schema: AFFINITY }
    )
  }
}
log(`Affinity: ${affinity?.themes?.length || 0} theme(s), ${affinity?.delights?.length || 0} delight(s)`)

// ---- 4. Prioritize: rank themes into cut / keep / improve by prevalence × severity ----
phase('Prioritize')
const priorities = await agent(
  `You are the LEAD RESEARCHER turning the affinity map into recommendations. Affinity map:\n\n${JSON.stringify(affinity, null, 2)}\n\n` +
    `Prioritize into CUT / KEEP / IMPROVE, ranked by prevalence × severity (a friction many users hit and rated a blocker beats one user's pet ` +
    `peeve). KEEP = cross-user delights + strongly-valued features (don't break these). CUT = low-value / repeatedly-flagged-for-removal items. ` +
    `IMPROVE = high prevalence×severity frictions, ordered highest-impact first. For each: action, what, why (cite prevalence, severity, segments), ` +
    `prevalence, severity, and confidence — confidence is "high" ONLY when prevalence ≥ 2 AND the theme is grounded/mixed; cap single-user or ` +
    `fully-inferred items at "low". Return { cut:[...], keep:[...], improve:[...] }.`,
  { label: 'prioritize', phase: 'Prioritize', schema: PRIORITIZE }
)

// ---- 5. Report: users member-check the draft, researcher folds in corrections and writes the report ----
phase('Report')
const renderReco = (r) =>
  `- [${r.action}] ${r.what} — ${r.why} (prevalence ${r.prevalence}/${personas.length}, ${r.severity}, confidence ${r.confidence})`
const draftFindings =
  `CUT:\n${(priorities.cut || []).map(renderReco).join('\n') || '- (none)'}\n\n` +
  `KEEP:\n${(priorities.keep || []).map(renderReco).join('\n') || '- (none)'}\n\n` +
  `IMPROVE (ordered):\n${(priorities.improve || []).map(renderReco).join('\n') || '- (none)'}`

const memberChecks = await parallel(
  personas.map((p) => () =>
    evaluate(
      personaBlock(p),
      `The researcher has drafted these findings from the panel:\n\n${draftFindings}\n\n` +
        `Member-check ONLY your own experience: does anything here MISREPRESENT what mattered to you, mis-rank a pain you felt, or MISS something ` +
        `important for your job? If it fairly reflects you, say so in one line.`,
      `check-${p.name}`,
      'Report',
      p.model
    )
  )
)
const checkText =
  personas
    .map((p, i) => (memberChecks[i]?.text ? `${p.name} (${p.segment}):\n${memberChecks[i].text}` : null))
    .filter(Boolean)
    .join('\n\n') || '(none raised)'

const TEMPLATE = `# User-research panel — ${surface}

> Simulated qualitative research. **Method:** ${personas.length} persona evaluators, each voiced by a different model, inspected the product **read-only** (source + supplied artifacts) and walked the task scenarios through their Jobs-To-Be-Done. This is **heuristic / inspection-based** expert review that generates **hypotheses** — it is NOT empirical usability testing. See "Validate with real users" before acting.

## Research goal
<one paragraph>

## Panel (who we simulated)
| Persona | Segment | JTBD | Model | Verdict |
|---|---|---|---|---|
<one row per user; Verdict from each user's closing "Verdict:" line>

## Task scenarios evaluated
<numbered list>

## Headline findings (prioritized)
The bar: prevalence (how many of ${personas.length} users independently hit it) × severity.
### Cut
- **<what>** — <why> · prevalence k/${personas.length} · <severity> · confidence <high|medium|low>
### Keep
- **<what>** — <why> · prevalence k/${personas.length} · confidence <…>
### Improve (highest impact first)
1. **<what>** — <why> · prevalence k/${personas.length} · <severity> · confidence <…>

## Themes (affinity map)
| Theme | Prevalence | Severity | Segments | Basis |
|---|---|---|---|---|
<one row per theme; Basis = grounded / mixed / inferred>

## Frictions by task
<per task scenario: the frictions users hit, severity, observed-vs-inferred>

## Delights (what's working)
- <…>

## Divergences (where segments disagreed)
- <…>

## Perceived snappiness (INFERRED — not measured)
<what the implementation suggests about responsiveness; hypotheses to confirm with real perf data>

## Aesthetic / design impressions (INFERRED — not rendered)
<design read from code/artifacts; hypotheses to confirm visually>

## Representative voices
> "<first-person quote>" — <persona>

## Validate with real users (before acting)
These findings are model-simulated inferences. Confirm the high-impact ones before committing scope:
- <finding> → <how to validate: usability test / analytics event / perf trace / screenshot review>

## Open questions
- <…>

## Suggested next step
Run \`gated-plan-create\` against this report to turn the **Improve / Cut** list into a commit-level plan. Treat **low-confidence** and **inferred** items as candidates for \`excluded\` or a validation phase.`

const result = await agent(
  `You are the LEAD RESEARCHER writing the final research report.\n\n` +
    `Surface: ${surface}\nFocus: ${focusLine}\nResearch goal: ${researchGoal}\n\n` +
    `Panel (persona — segment — model): ${personas.map((p) => `${p.name} — ${p.segment} — ${p.model}`).join('; ')}\n\n` +
    `Task scenarios:\n${renderTasks(taskScenarios)}\n\n` +
    `Affinity map (JSON):\n${JSON.stringify(affinity, null, 2)}\n\n` +
    `Prioritization (JSON):\n${JSON.stringify(priorities, null, 2)}\n\n` +
    `Full session notes (use for quotes + each user's Verdict line):\n\n${renderSessions(sessions)}\n\n` +
    `Panel member-check notes:\n\n${checkText}\n\n` +
    `Fold the legitimate member-check corrections in. Then WRITE the report to \`${reportPath}\` using the Write tool (first ensure the ` +
    `directory exists: Bash \`mkdir -p ${outDir}\`). Use EXACTLY this section structure, filling every placeholder:\n\n${TEMPLATE}\n\n` +
    `Honesty rules (non-negotiable): every snappiness/aesthetic claim stays under its INFERRED heading and is framed as a hypothesis; ` +
    `single-user or fully-inferred findings keep confidence "low"; cite repo files/screens for concrete claims; never list a feature that isn't in ` +
    `the repo/artifacts; the "Validate with real users" section must give a concrete way to confirm each high-impact finding; surface divergence ` +
    `honestly rather than flattening it to a fake consensus. ` +
    `Return { reportPath:"${reportPath}", summary:<3–4 sentence plain summary: the headline cut/keep/improve calls and the biggest caveat> }.`,
  { label: 'finalize', phase: 'Report', schema: FINAL }
)

return {
  reportPath,
  surface,
  researchGoal,
  panel: personas.map((p) => `${p.name} (${p.segment}) — ${p.model}`),
  themes: affinity?.themes?.length || 0,
  summary: result?.summary || '',
}
