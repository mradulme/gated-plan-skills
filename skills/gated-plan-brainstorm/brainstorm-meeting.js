export const meta = {
  name: 'brainstorm-meeting',
  description:
    'Run a simulated design meeting on a subjective topic: a chair (this workflow) casts a roster of clashing personas, each backed by one difficulty-matched model on the intelligence ladder (kimi → minimax → sonnet → glm → gpt, via cline plan-mode / claude read-only, with quota/auth fallback), then drives them through opening positions → facilitator-mediated debate rounds → convergence → a final objections pass, and writes a decision brief that gated-plan-create can consume',
  whenToUse:
    'Invoked by the gated-plan-brainstorm skill to deliberate an open-ended question into concrete decisions/directions before planning',
  phases: [
    { title: 'Cast' },
    { title: 'Open' },
    { title: 'Debate' },
    { title: 'Converge' },
    { title: 'Objections' },
  ],
}

// args = { topic, outDir='docs/brainstorms', maxPersonas=5, maxRounds=3 }
// args may arrive as an object or, depending on the harness, a JSON string — normalize both.
const _args = typeof args === 'string' ? JSON.parse(args) : args || {}
const { topic, outDir = 'docs/brainstorms', maxPersonas = 5, maxRounds = 3 } = _args
if (!topic) throw new Error('args.topic is required (the subjective question to brainstorm)')

const slug =
  String(topic).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brainstorm'
const briefPath = `${outDir}/${slug}.md`

// ---- Intelligence ladder, copied from gated-plan-execute/phase-review-loop.js. Each skill is
// standalone (repo convention — a shared lib would be the over-engineering they already avoided), so
// the ladder + CLI invocation + quota/auth fallback are duplicated here verbatim. Tiers ascend by score.
const CLINE = '/opt/homebrew/bin/cline'
const CLAUDE = '$HOME/.local/bin/claude'
const LADDER = [
  { tier: 1, name: 'kimi-k2.7', score: 42, kind: 'cline', args: '-P moonshot -m kimi-k2.7-code' },
  { tier: 2, name: 'minimax-m3', score: 44, kind: 'cline', args: '-P minimax -m MiniMax-M3 --thinking high' },
  { tier: 3, name: 'claude-sonnet-4-6', score: 47, kind: 'claude', model: 'claude-sonnet-4-6' },
  { tier: 4, name: 'glm-5.2', score: 51, kind: 'cline', args: '-P zai-coding-plan -m glm-5.2 --thinking high' },
  { tier: 5, name: 'gpt-5.5', score: 54, kind: 'cline', args: '-P openai-codex -m gpt-5.5 --thinking high' },
  { tier: 6, name: 'claude-opus-4-8', score: 56, kind: 'claude', model: 'claude-opus-4-8' },
]
const clampTier = (t) => Math.max(1, Math.min(LADDER.length, Math.round(t) || 1))
// Topic difficulty 1-5 → the single tier that backs EVERY persona (the chair, on the session model, is
// effectively the top of the ladder). Opus (tier 6) is never a persona — it chairs.
const tierFor = (difficulty) => ({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }[Math.max(1, Math.min(5, Math.round(difficulty) || 3))])
// Quota/auth fallback order: chosen tier, then higher tiers ascending, then lower descending — so an
// unavailable model degrades to the nearest equal-or-stronger first and can never silently block a turn.
const candidatesFor = (tier) => {
  const t = clampTier(tier)
  const up = []
  for (let i = t + 1; i <= LADDER.length; i++) up.push(LADDER[i - 1])
  const down = []
  for (let i = t - 1; i >= 1; i--) down.push(LADDER[i - 1])
  return [LADDER[t - 1], ...up, ...down]
}
// READ-ONLY invocation. The persona prompt (topic + transcript) carries arbitrary text, so it is written
// to a temp file and passed via "$(cat ...)" — the shell does not re-interpret backticks/$/quotes/newlines.
// cline -p is PLAN mode (investigates, cannot edit); claude is held read-only by --allowedTools. No --json
// (it re-emits every event — token bloat); redirect to a temp file and tail it.
const readCmd = (m, pf, out) =>
  m.kind === 'cline'
    ? `${CLINE} -p ${m.args} "$(cat ${pf})" > ${out} 2>&1; tail -n 120 ${out}`
    : `${CLAUDE} -p "$(cat ${pf})" --model ${m.model} --allowedTools "Bash(git:*)" "Read" "Grep" "Glob" > ${out} 2>&1; tail -n 120 ${out}`

const SPEAK = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'model'],
  properties: { text: { type: 'string' }, model: { type: 'string' } },
}
const CAST = {
  type: 'object',
  additionalProperties: false,
  required: ['centralQuestion', 'difficulty', 'personas'],
  properties: {
    centralQuestion: { type: 'string' },
    difficulty: { type: 'integer' },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'stance'],
        properties: { name: { type: 'string' }, role: { type: 'string' }, stance: { type: 'string' } },
      },
    },
  },
}
const SYNTH = {
  type: 'object',
  additionalProperties: false,
  required: ['agreements', 'clashes', 'openQuestions', 'converged'],
  properties: {
    agreements: { type: 'array', items: { type: 'string' } },
    clashes: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    converged: { type: 'boolean' },
  },
}
const FINAL = {
  type: 'object',
  additionalProperties: false,
  required: ['briefPath', 'summary'],
  properties: { briefPath: { type: 'string' }, summary: { type: 'string' } },
}

// The single tier backing every persona this meeting — set by the chair's difficulty rating in Cast.
// ponytail: single difficulty-matched tier (the user's choice); to mix ladder models per persona for more
// idea-diversity, give each persona its own tier and call candidatesFor(thatTier) inside speak().
let tier = 3

const personaBrief = (p) => `${p.name} — ${p.role}.\nYour stance / bias (argue from this): ${p.stance}`

const renderTranscript = (t) => {
  if (!t.length) return '(nothing said yet)'
  const byRound = {}
  for (const e of t) (byRound[e.round] ||= []).push(e)
  return Object.keys(byRound)
    .sort((a, b) => a - b)
    .map((r) => `--- Round ${r} ---\n` + byRound[r].map((e) => `${e.name}:\n${e.text}`).join('\n\n'))
    .join('\n\n')
}
const renderSynth = (s) => {
  if (!s) return ''
  const list = (xs, empty) => (xs && xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${empty}`)
  return (
    `Agreements:\n${list(s.agreements, '(none yet)')}\n\n` +
    `Open clashes:\n${list(s.clashes, '(none)')}\n\n` +
    `Open questions:\n${list(s.openQuestions, '(none)')}`
  )
}

// Relay ONE persona turn to a read-only CLI model. Like gated-plan-execute's reviewer, but the prompt is
// file-fed (arbitrary transcript text) and the model speaks IN CHARACTER instead of reviewing.
const speak = (persona, body, label, phaseLabel) => {
  const lslug = label.replace(/[^a-z0-9]+/gi, '-')
  const pf = `/tmp/gpb-prompt-${lslug}.txt`
  const cands = candidatesFor(tier)
  const cmdList = cands
    .map((m, i) => `  ${i + 1}. ${m.name} (tier ${m.tier}): ${readCmd(m, pf, `/tmp/gpb-out-${lslug}-${m.tier}.txt`)}`)
    .join('\n')
  const full =
    `You are a participant in a live design brainstorm meeting. Stay FULLY in character as this persona and ` +
    `argue from its viewpoint — do not be a neutral assistant:\n\n${persona}\n\n${body}\n\n` +
    `Keep it to a few focused paragraphs. Be concrete and cite specifics (you may read the repo to ground your view) ` +
    `over generalities.`
  return agent(
    `You are relaying ONE turn of a brainstorm meeting to a read-only CLI model — do NOT answer yourself. First write ` +
      `the meeting prompt (given at the END, after the marker) VERBATIM to ${pf} using the Write tool, so ` +
      `backticks/$/quotes/newlines are preserved exactly. Then try the commands below STRICTLY ONE AT A TIME, IN ORDER, ` +
      `each exactly as written (absolute paths — the shell does not source ~/.zshrc), with Bash timeout 600000 ms. Each is ` +
      `READ-ONLY (cline in PLAN mode -p; claude held by --allowedTools) — the model may read repo files to ground itself ` +
      `but edits nothing. Do NOT pass --json. Read ONLY the tail.\n\n${cmdList}\n\n` +
      `Decide after each command:\n` +
      `• It produced the persona's contribution → STOP, return { text:<the model's full response, verbatim>, ` +
      `model:<that model's name> }.\n` +
      `• It could NOT run — out of credits/quota/rate-limit, OR (for cline) an auth/unauthenticated/expired-or-invalid-token ` +
      `error (e.g. a single line "error: The usage limit has been reached" or "error: Invalid Authentication", exit 1) → ` +
      `that model is UNAVAILABLE: move to the NEXT command and try again.\n` +
      `If EVERY candidate is unavailable, return { text:"(no model available to speak this turn)", model:"none" }.` +
      `\n\n--- MEETING PROMPT (write this verbatim to ${pf}) ---\n${full}`,
    { label, phase: phaseLabel, schema: SPEAK }
  )
}

// ---- 1. Cast: the chair sharpens the question, casts the roster, and rates difficulty → tier ----
phase('Cast')
const cast = await agent(
  `You are the CHAIR of a design brainstorm meeting. Topic:\n\n${topic}\n\n` +
    `Do three things. (1) Sharpen the topic into ONE crisp central question the meeting must answer. ` +
    `(2) Cast a roster of 3–${maxPersonas} personas to debate it, with DELIBERATELY CLASHING stances so the debate is ` +
    `real, not an echo chamber. Match the KIND of persona to the topic: for an engineering/design/technical question, ` +
    `cast domain-expert stance archetypes (e.g. architect vs pragmatist SRE vs velocity-advocate vs security lead vs ` +
    `migration-scarred skeptic) — the clash is HOW to think about the problem. For a cross-functional/business/strategy ` +
    `question, cast role/stakeholder voices including C-suite where apt (e.g. CTO vs CMO vs CPO vs CFO vs a ` +
    `customer-success voice) — the clash is WHOSE interest wins. Pick whichever fits; mix them if the topic genuinely ` +
    `spans both. Give each a short name, a role, and a one-line stance/bias they argue from. (3) Rate the topic's ` +
    `difficulty 1–5 (1 = light/low-stakes, 5 = deep, ` +
    `high-stakes, ambiguous, architecturally loaded) — this picks the single model tier backing every persona. ` +
    `Return { centralQuestion, difficulty, personas:[{name,role,stance}] }.`,
  { label: 'cast', phase: 'Cast', schema: CAST }
)
const personas = (cast.personas || []).slice(0, maxPersonas)
if (personas.length < 2) throw new Error('chair cast fewer than 2 personas — cannot hold a debate')
const centralQuestion = cast.centralQuestion
tier = tierFor(cast.difficulty)
log(`Cast ${personas.length} personas at tier ${tier} (${LADDER[tier - 1].name}); Q: ${centralQuestion}`)

// ---- 2. Open: each persona states an opening position (parallel), chair synthesizes ----
phase('Open')
const transcript = []
const openings = await parallel(
  personas.map((p) => () =>
    speak(
      personaBrief(p),
      `The meeting topic:\n${topic}\n\nThe central question: ${centralQuestion}\n\n` +
        `This is the OPENING round. State your initial position: where you stand on the central question, your reasoning, ` +
        `and the considerations that matter most from your viewpoint.`,
      `open-${p.name}`,
      'Open'
    )
  )
)
personas.forEach((p, i) => {
  if (openings[i]?.text) transcript.push({ name: `${p.name} (${p.role})`, round: 1, text: openings[i].text })
})
let synth = await agent(
  `You are the CHAIR. Central question: ${centralQuestion}\n\nThe opening positions:\n\n${renderTranscript(transcript)}\n\n` +
    `Synthesize: what do the participants AGREE on, where do they CLASH, and what key questions are still OPEN? ` +
    `Set converged=true ONLY if the room already has enough agreement and clarity to draft firm decisions; otherwise false.`,
  { label: 'synth-1', phase: 'Open', schema: SYNTH }
)

// ---- 3. Debate: facilitator-mediated rounds until the chair calls convergence or the cap is hit ----
phase('Debate')
let round = 1
while (!synth.converged && round <= maxRounds) {
  round++
  const turns = await parallel(
    personas.map((p) => () =>
      speak(
        personaBrief(p),
        `The central question: ${centralQuestion}\n\nThe discussion so far:\n\n${renderTranscript(transcript)}\n\n` +
          `The chair's read of the room:\n${renderSynth(synth)}\n\n` +
          `Respond to the others. Where do you agree, where do you push back (name who and why), and what do you add or ` +
          `revise? Push the room toward CONCRETE decisions on the open questions. Do not repeat your earlier turn — move it forward.`,
        `debate${round}-${p.name}`,
        'Debate'
      )
    )
  )
  personas.forEach((p, i) => {
    if (turns[i]?.text) transcript.push({ name: `${p.name} (${p.role})`, round, text: turns[i].text })
  })
  synth = await agent(
    `You are the CHAIR. Central question: ${centralQuestion}\n\nThe full discussion:\n\n${renderTranscript(transcript)}\n\n` +
      `Re-synthesize agreements, remaining clashes, and still-open questions. Set converged=true ONLY when the room has ` +
      `enough resolution to commit to decisions and directions; otherwise false and the debate continues.`,
    { label: `synth-${round}`, phase: 'Debate', schema: SYNTH }
  )
  log(`Round ${round}: ${synth.converged ? 'converged' : 'still diverging'} — ${synth.clashes?.length || 0} open clash(es)`)
}

// ---- 4. Converge: the chair drafts the decision brief ----
phase('Converge')
const draft = await agent(
  `You are the CHAIR writing the meeting's decision brief. Topic:\n${topic}\n\nCentral question: ${centralQuestion}\n\n` +
    `Full discussion:\n\n${renderTranscript(transcript)}\n\nYour latest synthesis:\n${renderSynth(synth)}\n\n` +
    `Write a decision brief in Markdown with these sections:\n` +
    `# <title>\n## Central question\n## Options weighed (with the trade-offs the room surfaced)\n` +
    `## Decisions & directions (what we're doing — concrete enough to plan into commits)\n## Rationale\n` +
    `## Risks & watch-items\n## Open questions (left unresolved)\n## Recommended next steps\n\n` +
    `Be decisive where the room converged; record dissent honestly where it did not. This brief is the INPUT to ` +
    `gated-plan-create, so the decisions/directions must be concrete and actionable. Return only the Markdown.`,
  { label: 'draft', phase: 'Converge' }
)

// ---- 5. Objections: personas critique the draft (parallel), chair folds them in and writes the file ----
phase('Objections')
const objections = await parallel(
  personas.map((p) => () =>
    speak(
      personaBrief(p),
      `The chair has drafted this brief from our meeting:\n\n${draft}\n\n` +
        `As your persona, give a final check: list any OBJECTIONS, factual errors, or important points it MISSED or ` +
        `misrepresented from your viewpoint. If it fairly captures your position, say so in one line.`,
      `obj-${p.name}`,
      'Objections'
    )
  )
)
const objText =
  personas
    .map((p, i) => (objections[i]?.text ? `${p.name} (${p.role}):\n${objections[i].text}` : null))
    .filter(Boolean)
    .join('\n\n') || '(none raised)'

const result = await agent(
  `You are the CHAIR finalizing the brief. Here is your draft:\n\n${draft}\n\n` +
    `The participants' final objections / missed points:\n\n${objText}\n\n` +
    `Fold in the legitimate objections — fix errors, add missed considerations, and where the room would genuinely ` +
    `dispute a decision, record the dissent rather than papering over it. Then WRITE the final Markdown brief to the file ` +
    `\`${briefPath}\` using the Write tool (first ensure the directory exists: Bash \`mkdir -p ${outDir}\`). ` +
    `Return { briefPath:"${briefPath}", summary:<3–4 sentence plain summary of the decisions and any unresolved dissent> }.`,
  { label: 'finalize', phase: 'Objections', schema: FINAL }
)

return {
  briefPath,
  centralQuestion,
  personas: personas.map((p) => `${p.name} (${p.role})`),
  rounds: round,
  summary: result?.summary || '',
}
