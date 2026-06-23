#!/usr/bin/env node
// gated-plan model pool — the single on-disk source of truth for which model CLI runs a task,
// how each is invoked, and how well each has performed. The Workflow scripts (brainstorm-meeting.js,
// phase-review-loop.js) run in a sandbox with NO filesystem / require / Math.random / Date.now, so
// all of that lives here and the workflows' agent() subagents shell out to it:
//
//   node pool.mjs route  --role <implement|fix|review|brainstorm|advisory> --file <prompt/task file>
//                        --out <output file> [--exclude id,id]
//       → prints { chosen: { id, command } | null, fallbackIds: [...] }: ONE runnable command (the top
//         pick, fair-warmup then epsilon-greedy by value) plus the ranked fallback ids (no commands).
//         The caller runs `chosen`; only on "unavailable" does it re-route with --exclude to get the
//         next single command — so it never holds more than one runnable command at a time. Then it
//         records the one that actually ran.
//
//   node pool.mjs record --role <r> --model <id> --available <true|false>
//                        [--committed true|false] [--gate-first-try true|false]
//                        [--rounds N] [--p1 N] [--p2 N] [--stuck true|false]
//       → appends one JSON line to ~/.gated-plan/events.jsonl (repo auto-detected from cwd).
//
//   node pool.mjs stats  [--role <r>] [--json]   → leaderboard with value = quality / cost.
//   node pool.mjs pricing [--force]              → refresh ~/.gated-plan/pricing.json from OpenRouter.
//
// claude (Opus/Sonnet) is intentionally NOT in the routable registry — it is the native last resort
// the workflow invokes directly (no CLI), so it can never skew the rankings.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const DATA_DIR = path.join(HOME, '.gated-plan')
const EVENTS = path.join(DATA_DIR, 'events.jsonl')
const PRICING = path.join(DATA_DIR, 'pricing.json')
const CLAUDE = `${HOME}/.local/bin/claude`
const TAIL = (out) => ` > ${out} 2>&1; tail -n 120 ${out}`

// ---- Registry: the only environment-specific block. Resolved invocations (absolute paths / config
// dirs) — NOT the ~/.zshrc aliases, which a non-interactive shell does not source. Each builds a full
// shell command that feeds the prompt via "$(cat <file>)" (so backticks/$/quotes/newlines are passed
// as one arg the shell does not re-interpret) and tails the output. `or` = OpenRouter pricing hints
// (substring match against the catalog); `iq` = published intelligence score (tiebreaker only).
const REGISTRY = [
  {
    id: 'cursor',
    label: 'Cursor agent (auto-routed)',
    iq: null, // Cursor auto-routes; no single model/price
    write: true,
    read: true,
    or: [], // opaque pricing — ranked on its own line
    writeCmd: (f, o) => `/Users/mradul/.local/bin/agent -p --force "$(cat ${f})"${TAIL(o)}`,
    readCmd: (f, o) => `/Users/mradul/.local/bin/agent -p --trust "$(cat ${f})"${TAIL(o)}`,
  },
  {
    id: 'glm',
    label: 'GLM 5.2',
    iq: 51.1,
    write: true,
    read: true,
    or: ['z-ai/glm-5.2', 'glm-5.2', 'glm-5', 'glm-4.6'],
    writeCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-glm ${CLAUDE} -p --dangerously-skip-permissions "$(cat ${f})"${TAIL(o)}`,
    readCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-glm ${CLAUDE} -p --permission-mode plan "$(cat ${f})"${TAIL(o)}`,
  },
  {
    id: 'minimax',
    label: 'MiniMax M3',
    iq: 44.4,
    write: true,
    read: true,
    or: ['minimax/minimax-m3', 'minimax-m3', 'minimax/minimax-m2', 'minimax'],
    writeCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-minimax ${CLAUDE} -p --dangerously-skip-permissions "$(cat ${f})"${TAIL(o)}`,
    readCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-minimax ${CLAUDE} -p --permission-mode plan "$(cat ${f})"${TAIL(o)}`,
  },
  {
    id: 'kimi',
    label: 'Kimi 2.7',
    iq: 41.9,
    write: true,
    read: true,
    or: ['moonshotai/kimi-k2.7', 'kimi-k2.7', 'moonshotai/kimi-k2', 'kimi-k2'],
    // Claude Code aliased to Kimi's Anthropic-compatible coding endpoint via an isolated config dir
    // (~/.claude-kimi/settings.json: base_url + auth token + alwaysThinkingEnabled so K2.7 is reached,
    // not K2.6). Same shape as glm/minimax — write skips permissions, review runs read-only plan mode.
    writeCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-kimi ${CLAUDE} -p --dangerously-skip-permissions "$(cat ${f})"${TAIL(o)}`,
    readCmd: (f, o) =>
      `CLAUDE_CONFIG_DIR=${HOME}/.claude-kimi ${CLAUDE} -p --permission-mode plan "$(cat ${f})"${TAIL(o)}`,
  },
  {
    id: 'codex',
    label: 'GPT 5.5 (codex)',
    iq: 54.8,
    write: true,
    read: true,
    or: ['openai/gpt-5.5', 'gpt-5.5', 'openai/gpt-5.1', 'openai/gpt-5'],
    writeCmd: (f, o) =>
      `/opt/homebrew/bin/codex exec --dangerously-bypass-approvals-and-sandbox "$(cat ${f})"${TAIL(o)}`,
    readCmd: (f, o) => `/opt/homebrew/bin/codex exec -s read-only "$(cat ${f})"${TAIL(o)}`,
  },
]

// Map a fine-grained role to a routing bucket. Buckets accumulate samples faster than fine roles and
// decide eligibility: code = write-capable; review/advise = read-only.
const BUCKET = { implement: 'code', fix: 'code', gatefix: 'code', review: 'review', 'branch-review': 'review', brainstorm: 'advise', advisory: 'advise', research: 'advise' }
const bucketOf = (role) => BUCKET[role] || 'code'
const needsWrite = (role) => bucketOf(role) === 'code'

const MIN_SAMPLES = 3 // per (model, bucket) before we stop forcing fair exploration

// ---- small utils ----
const ensureDir = () => fs.mkdirSync(DATA_DIR, { recursive: true })
const readEvents = () => {
  try {
    return fs
      .readFileSync(EVENTS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
const readPricing = () => {
  try {
    return JSON.parse(fs.readFileSync(PRICING, 'utf8'))
  } catch {
    return {}
  }
}
const parseArgs = (argv) => {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[k] = true
      else {
        out[k] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}
const asBool = (v) => v === true || v === 'true' || v === '1'
const repoName = () => {
  try {
    return path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  } catch {
    return path.basename(process.cwd())
  }
}

// ---- scoring: per (model, bucket) quality in 0..1, and value = quality / cost ----
// code:   availability × commit-rate × rounds-score (fewer review rounds to clean = better).
// review: availability × engagement (a reviewer that only ever returns "clean" or fails is low-signal).
//         Soft by design — code is the high-confidence signal; review usefulness is a proxy.
// advise: availability only (subjective; we track participation, not "correctness").
const score = (events, id, bucket) => {
  const rows = events.filter((e) => e.model === id && bucketOf(e.role) === bucket)
  const n = rows.length
  if (!n) return { n: 0, quality: null, availRate: null, commitRate: null, avgRounds: null, stuckRate: null }
  const avail = rows.filter((e) => e.available !== false)
  const availRate = avail.length / n
  let quality
  let commitRate = null
  let avgRounds = null
  let stuckRate = null
  if (bucket === 'code') {
    const committed = avail.filter((e) => e.committed)
    commitRate = avail.length ? committed.length / avail.length : 0
    const withRounds = committed.filter((e) => typeof e.rounds === 'number')
    avgRounds = withRounds.length ? withRounds.reduce((s, e) => s + e.rounds, 0) / withRounds.length : null
    stuckRate = avail.length ? avail.filter((e) => e.stuck).length / avail.length : 0
    const roundsScore = avgRounds == null ? 0.6 : 1 / (1 + avgRounds) // unknown → neutral-ish
    quality = availRate * commitRate * roundsScore * (1 - 0.5 * stuckRate)
  } else if (bucket === 'review') {
    // engagement = fraction of available reviews that actually produced findings or a clean verdict
    // without an availability failure; a "NO REVIEWER" P1 counts as a non-finding failure upstream.
    const engaged = avail.filter((e) => (e.p1 || 0) + (e.p2 || 0) >= 0) // every available review is engaged
    quality = availRate * (avail.length ? engaged.length / avail.length : 0)
  } else {
    quality = availRate
  }
  return { n, quality, availRate, commitRate, avgRounds, stuckRate }
}

// blended $ per 1M tokens (30% prompt / 70% completion). null when pricing unknown.
const costPerM = (id, pricing) => {
  const p = pricing[id]
  if (!p || (p.prompt == null && p.completion == null)) return null
  const prompt = (p.prompt || 0) * 1e6
  const completion = (p.completion || 0) * 1e6
  return 0.3 * prompt + 0.7 * completion
}

// ---- ordering: registry entries best→worst for a role, applying fair-warmup then epsilon-greedy ----
const orderedEligible = (role, excludeSet) => {
  const bucket = bucketOf(role)
  const write = needsWrite(role)
  const eligible = REGISTRY.filter((m) => !excludeSet.has(m.id) && (write ? m.write : m.read))
  if (!eligible.length) return []

  const events = readEvents()
  const pricing = readPricing()
  const meta = new Map(
    eligible.map((m) => {
      const s = score(events, m.id, bucket)
      const cost = costPerM(m.id, pricing)
      const value = s.quality == null || !cost ? null : s.quality / cost
      return [m.id, { ...s, cost, value }]
    })
  )

  // 1) Fair warmup: while any eligible model is under MIN_SAMPLES for this bucket, order by fewest
  //    samples first (ties → higher published IQ, then random) so every model earns a real track record.
  const minN = Math.min(...eligible.map((m) => meta.get(m.id).n))
  if (minN < MIN_SAMPLES) {
    return [...eligible].sort((a, b) => {
      const na = meta.get(a.id).n
      const nb = meta.get(b.id).n
      if (na !== nb) return na - nb
      if ((b.iq || 0) !== (a.iq || 0)) return (b.iq || 0) - (a.iq || 0)
      return Math.random() - 0.5
    })
  }
  // 2) Epsilon-greedy: explore with prob eps (decays as the bucket accrues data, floor 0.1);
  //    otherwise exploit by value (→ quality → IQ).
  const total = eligible.reduce((s, m) => s + meta.get(m.id).n, 0)
  const eps = Math.max(0.1, Math.min(0.4, 1 / Math.sqrt(total)))
  const byValue = [...eligible].sort((a, b) => {
    const va = meta.get(a.id)
    const vb = meta.get(b.id)
    const sa = va.value ?? va.quality ?? 0
    const sb = vb.value ?? vb.quality ?? 0
    if (sb !== sa) return sb - sa
    return (b.iq || 0) - (a.iq || 0)
  })
  if (Math.random() < eps) {
    const rest = byValue.slice(1)
    const pick = rest.length ? rest[Math.floor(Math.random() * rest.length)] : byValue[0]
    return [pick, ...byValue.filter((m) => m.id !== pick.id)]
  }
  return byValue
}

const excludeOf = (args) => new Set(String(args.exclude || '').split(',').map((s) => s.trim()).filter(Boolean))
const buildCmd = (m, role, file, out) => (needsWrite(role) ? m.writeCmd(file, out) : m.readCmd(file, out))

// route: ONE runnable command (the top pick) + the ranked fallback ids (NO commands). The caller can
// only ever hold a single runnable command, so it cannot fan the same task out to several models; to
// try the next model it MUST re-route with --exclude <chosen.id>. chosen is null iff every eligible
// model is excluded/unavailable.
const route = (args) => {
  const role = args.role || 'implement'
  if (!args.file || !args.out) throw new Error('route requires --file and --out')
  const ordered = orderedEligible(role, excludeOf(args))
  const chosen = ordered.length
    ? { id: ordered[0].id, command: buildCmd(ordered[0], role, args.file, args.out) }
    : null
  process.stdout.write(
    JSON.stringify({ role, bucket: bucketOf(role), chosen, fallbackIds: ordered.slice(1).map((m) => m.id) })
  )
}

// list: just the ordered ids (used to spread distinct models across brainstorm personas).
const list = (args) => {
  const role = args.role || 'brainstorm'
  process.stdout.write(JSON.stringify({ role, ids: orderedEligible(role, excludeOf(args)).map((m) => m.id) }))
}

// cmdFor: the single command for ONE pinned model id (brainstorm assigns a specific voice per persona).
const cmdFor = (args) => {
  const role = args.role || 'brainstorm'
  if (!args.id || !args.file || !args.out) throw new Error('cmd requires --id, --file and --out')
  const m = REGISTRY.find((x) => x.id === args.id)
  if (!m) throw new Error(`unknown model id: ${args.id}`)
  process.stdout.write(JSON.stringify({ id: m.id, command: buildCmd(m, role, args.file, args.out) }))
}

// ---- record ----
const record = (args) => {
  ensureDir()
  const evt = {
    ts: new Date().toISOString(),
    repo: args.repo || repoName(),
    role: args.role || 'implement',
    model: args.model || 'unknown',
    available: args.available === undefined ? true : asBool(args.available),
  }
  if (args.committed !== undefined) evt.committed = asBool(args.committed)
  if (args['gate-first-try'] !== undefined) evt.gateFirstTry = asBool(args['gate-first-try'])
  if (args.rounds !== undefined) evt.rounds = Number(args.rounds)
  if (args.p1 !== undefined) evt.p1 = Number(args.p1)
  if (args.p2 !== undefined) evt.p2 = Number(args.p2)
  if (args.stuck !== undefined) evt.stuck = asBool(args.stuck)
  if (args.detail) evt.detail = String(args.detail).slice(0, 200)
  fs.appendFileSync(EVENTS, JSON.stringify(evt) + '\n')
  process.stdout.write(JSON.stringify({ recorded: evt }))
}

// ---- pricing (OpenRouter) ----
const fetchPricing = async () => {
  ensureDir()
  const res = await fetch('https://openrouter.ai/api/v1/models')
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`)
  const { data } = await res.json()
  const byId = new Map(data.map((m) => [m.id, m]))
  const out = {}
  for (const m of REGISTRY) {
    let hit = null
    for (const hint of m.or || []) {
      hit = byId.get(hint) || data.find((d) => d.id.includes(hint))
      if (hit) break
    }
    out[m.id] = hit
      ? { orId: hit.id, prompt: Number(hit.pricing?.prompt) || 0, completion: Number(hit.pricing?.completion) || 0 }
      : { orId: null, prompt: null, completion: null }
  }
  out._fetchedAt = new Date().toISOString()
  fs.writeFileSync(PRICING, JSON.stringify(out, null, 2))
  return out
}
const pricingStale = () => {
  try {
    const age = Date.now() - fs.statSync(PRICING).mtimeMs
    return age > 7 * 24 * 3600 * 1000
  } catch {
    return true
  }
}

// ---- stats / leaderboard ----
const fmt = (v, d = 2) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v))
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const stats = (args) => {
  const events = readEvents()
  const pricing = readPricing()
  const buckets = args.role ? [bucketOf(args.role)] : ['code', 'review', 'advise']
  const report = {}
  for (const bucket of buckets) {
    const rows = REGISTRY.map((m) => {
      const s = score(events, m.id, bucket)
      const cost = costPerM(m.id, pricing)
      const value = s.quality == null || !cost ? null : s.quality / cost
      return { id: m.id, label: m.label, ...s, cost, value }
    }).filter((r) => r.n > 0)
    rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || (b.quality ?? -1) - (a.quality ?? -1))
    report[bucket] = rows
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ report, pricingFetchedAt: pricing._fetchedAt || null }, null, 2))
    return
  }

  const lines = []
  const title = { code: 'IMPLEMENTATION / FIX (write)', review: 'REVIEW (read-only)', advise: 'BRAINSTORM / ADVISORY (read-only)' }
  for (const bucket of buckets) {
    const rows = report[bucket]
    lines.push('')
    lines.push(`━━ ${title[bucket]} ━━`)
    if (!rows.length) {
      lines.push('  (no data yet)')
      continue
    }
    lines.push('  model         n   avail  ' + (bucket === 'code' ? 'commit  rounds  ' : '') + 'quality  $/Mtok   value')
    for (const r of rows) {
      const mid = bucket === 'code' ? `${pct(r.commitRate).padStart(6)}  ${fmt(r.avgRounds, 1).padStart(6)}  ` : ''
      lines.push(
        `  ${r.id.padEnd(12)} ${String(r.n).padStart(2)}  ${pct(r.availRate).padStart(5)}  ${mid}` +
          `${fmt(r.quality, 2).padStart(7)}  ${fmt(r.cost, 1).padStart(6)}  ${fmt(r.value, 4).padStart(7)}`
      )
    }
    const best = rows.find((r) => r.value != null) || rows[0]
    if (best) lines.push(`  → best value: ${best.id} (${best.label}). Invest here for ${title[bucket].toLowerCase()}.`)
  }
  lines.push('')
  lines.push(pricing._fetchedAt ? `(pricing fetched ${pricing._fetchedAt})` : '(no pricing — run: node pool.mjs pricing)')
  process.stdout.write(lines.join('\n') + '\n')
}

// ---- main ----
const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  switch (cmd) {
    case 'route':
      route(args)
      break
    case 'list':
      list(args)
      break
    case 'cmd':
      cmdFor(args)
      break
    case 'record':
      record(args)
      break
    case 'pricing':
      await fetchPricing()
      process.stdout.write('pricing updated\n')
      break
    case 'stats':
      if (pricingStale()) {
        try {
          await fetchPricing()
        } catch {
          /* offline — fall back to whatever cache exists */
        }
      }
      stats(args)
      break
    default:
      process.stdout.write(
        'usage: pool.mjs <route|list|cmd|record|stats|pricing> [flags]\n' +
          '  route  --role <r> --file <f> --out <o> [--exclude a,b]   one chosen command + fallback ids\n' +
          '  list   --role <r> [--exclude a,b]                        ordered model ids only\n' +
          '  cmd    --id <id> --role <r> --file <f> --out <o>         command for one pinned model\n' +
          '  record --role <r> --model <id> --available <bool> [--committed --rounds N --p1 N --p2 N --stuck]\n' +
          '  stats  [--role <r>] [--json]\n' +
          '  pricing\n'
      )
  }
}
main().catch((e) => {
  process.stderr.write(`pool.mjs error: ${e.message}\n`)
  process.exit(1)
})
