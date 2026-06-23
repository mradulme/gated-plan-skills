# gated-plan-skills

Three composing [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by an AI code-review loop** — and, before
that, for deciding *what the work even is*. All the model work — implementation, fixes, review, and
brainstorm/research personas — is routed across a **pool of model CLIs** (GLM 5.2, MiniMax M3, Kimi 2.7,
GPT 5.5/codex, and the Cursor agent) by a shared router that gives every model fair chances, then
favours the best **value-for-money** per task type, scoring each run to a central scoreboard. Claude
(Opus/Sonnet) is the **native last resort** only — kept out of the pool so it never skews rankings.

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-brainstorm` | `/gated-plan-brainstorm <topic>` | Runs a simulated design meeting on a subjective, open-ended topic: a chair casts a roster of deliberately-clashing personas (**each voiced by a different pooled model** — distinct minds clash, not one model role-playing all) and drives them through opening positions → debate rounds → convergence → an objections pass, then writes a decision brief to `docs/brainstorms/<topic>.md`. |
| `gated-plan-research` | `/gated-plan-research <surface>` | Runs a simulated user-research panel on an **existing** product: a lead researcher recruits user personas (**each with a JTBD + pain points, each voiced by a different pooled model**, read-only) who **independently** walk the product through their jobs, then clusters findings by **prevalence × severity** into a prioritized **cut / keep / improve** report at `docs/research/<surface>.md`. The pooled models inspect source read-only (can't run the app), so snappiness/aesthetics are inferred hypotheses flagged for real-user validation. |
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. Takes a brainstorm brief or a raw task as input. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** (one commit each) — each item's impl/fix **delegated to a pooled write-capable model** (edits + commits) — reviewed by a separate read-only pass run by a **different** pooled model (implementer ≠ reviewer) that loops fix→recommit→re-review until the commit is clean, then runs one final review of the whole branch vs `main`. |
| `delegate` | `/delegate <task>` | Ad-hoc hand-off of one isolated piece of work to a pooled model CLI (or a native Claude subagent) when it improves cost/speed/quality — read-only for investigation/review/critique/debugging, write only for clearly-scoped implementation. Same pool and scoreboard as `gated-plan-execute`, but driven on demand instead of from a plan: gets the exact invocation from `pool.mjs`, runs it, and records the outcome to the central scoreboard. |

They compose: **brainstorm → create → execute**. `brainstorm` is optional — start there when the
direction is still subjective; skip straight to `create` when the work is already concrete.
`gated-plan-research` is a parallel front-end — start there to gather simulated user feedback on an
*existing* product into a cut/keep/improve report `create` can read. The
coupling is light: `brainstorm` writes a markdown brief that `create` reads, and `create` emits
exactly the YAML schema `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do`
scope, a `gate`, and a `done` flag).

## Requirements

- **A pool of model CLIs**, each installed and authenticated. The pool, its exact invocations, and the
  routing/scoring all live in one editable file — `skills/_shared/pool.mjs` — which is the single
  source of truth. Out of the box it knows:
  - `glm` — GLM 5.2 (Claude Code routed via `CLAUDE_CONFIG_DIR=~/.claude-glm`)
  - `minimax` — MiniMax M3 (Claude Code routed via `CLAUDE_CONFIG_DIR=~/.claude-minimax`)
  - `kimi` — Kimi 2.7 (`kimi-code`)
  - `codex` — GPT 5.5 (`codex exec`)
  - `cursor` — the [Cursor `agent` CLI](https://cursor.com/docs/cli/overview) (auto-routed, codebase index)

  Each is invoked write-capable for impl/fix (edits + commits) and read-only for review/brainstorm.
  pool.mjs emits absolute / config-dir invocations (the shell doesn't source `~/.zshrc`), so only the
  CLIs you actually have need to work — an unavailable one is skipped and the router falls through.
  You don't have to run all five; edit the registry in `pool.mjs` to match what you have installed.
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) (`claude`) — logged in. Runs the
  skills themselves (the orchestrating session) **and** is the native last-resort fallback when a
  pooled item is stuck or the whole pool is unavailable.
- [Node.js](https://nodejs.org) (for `pool.mjs`; uses only built-ins) and `git` (work happens on real
  branches/commits).

## Install

### As a plugin (recommended)

```
/plugin marketplace add mradulme/gated-plan-skills
/plugin install gated-plan-skills@gated-plan-skills
```

### Manual (symlink into user skills)

```
git clone https://github.com/mradulme/gated-plan-skills.git
ln -s "$PWD/gated-plan-skills/skills/gated-plan-brainstorm" ~/.claude/skills/gated-plan-brainstorm
ln -s "$PWD/gated-plan-skills/skills/gated-plan-research"   ~/.claude/skills/gated-plan-research
ln -s "$PWD/gated-plan-skills/skills/gated-plan-create"     ~/.claude/skills/gated-plan-create
ln -s "$PWD/gated-plan-skills/skills/gated-plan-execute"    ~/.claude/skills/gated-plan-execute
ln -s "$PWD/gated-plan-skills/skills/delegate"             ~/.claude/skills/delegate
```

Skills load at session start — start a fresh Claude Code session after installing.

## Usage

```
/gated-plan-brainstorm should we split the auth service out of the monolith?
#   → runs the meeting, writes docs/brainstorms/<topic>.md (skip this step if the work is already concrete)

/gated-plan-research the onboarding flow
#   → runs the user panel, writes docs/research/<surface>.md (qualitative cut/keep/improve on an existing product)

/gated-plan-create add full test + lint + typecheck coverage to the app
#   → writes docs/plans/<name>.yaml (can take the brainstorm brief as input)

/gated-plan-execute docs/plans/<name>.yaml
#   → runs phase 1 (branch, commit each item, review-gated), reports, asks before the next phase
```

`gated-plan-execute` skips items already marked `done: true`, so re-invoking **resumes**.

## How the review gate works

For each item: a **pooled write-capable model** (chosen by the router) implements the item and commits.
The workflow never writes the code itself; it only drives the loop. Then, **before** any review, a
read-only subagent re-runs the item's own `gate` (its `npm run lint` / `typecheck` / `test` command)
on the committed HEAD — a hard precondition. A red gate is fixed and re-verified first, so the reviewer
never sees a build that doesn't lint/typecheck/test green. Once the gate is green, a review subagent
runs **one read-only reviewer — always a *different* model than whoever last authored the code** (so
implementer ≠ reviewer holds even after fixes) over the new commit.

The reviewer is **agentic and read-only**: it runs git and reads the code itself (not a diff dumped
into a prompt) but applies no edits. It returns the findings classified as **P1** (must-fix: bug,
regression, security, data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 →
a delegated fix (pooled, write-capable) addresses them and recommits → re-review. Capped at `maxRounds`
(default 7).

After every item in the phase is clean, one **final review of the whole branch against `reviewBase`**
(against `git diff main...HEAD`) runs to catch cross-commit interactions the per-commit gates can't
see, loop-fixing up to 3 rounds. Anything still open lands in `branchUnresolved`, surfaced before the
merge decision.

If a pooled model can't run (connection lost / max retries / quota / auth), the router falls through to
the next candidate; if the whole pool is unavailable, review returns a P1 "NO REVIEWER AVAILABLE"
rather than a silent clean pass, and impl/fix fall to the **native Claude** last resort (one shot, then
control returns to the loop).

## Model pool, routing & scoreboard

The router (`skills/_shared/pool.mjs`) turns the gate/review loop into a **multi-armed bandit over
coding agents**. It buckets work into three task types — **code** (implement/fix, write-capable),
**review**, and **advise** (brainstorm / research / sounding-board) — and for each:

- **Fair warmup** — until every model has a minimum number of runs in that bucket, it routes to the
  least-sampled model first, so each one earns a real track record before any get favoured.
- **Then value-driven** (epsilon-greedy) — it mostly picks the best **value = quality / cost**, with
  occasional exploration. *Quality* comes straight from the loop's own signals (did it commit? how few
  review rounds to clean? did it get stuck?); *cost* comes from live [OpenRouter](https://openrouter.ai)
  pricing.

Every run appends one line to **`~/.gated-plan/events.jsonl`** (shared across all your repos). See where
to invest the next dollar with:

```
node skills/_shared/pool.mjs stats          # leaderboard for all task types
node skills/_shared/pool.mjs stats --role implement   # just one
node skills/_shared/pool.mjs pricing        # refresh the OpenRouter pricing cache
```

The leaderboard shows, per model and task type: runs, availability, commit rate, avg review rounds,
quality, $/Mtok, and value — with a one-line "invest here" pick. Claude is deliberately absent (native
last resort, never ranked).

> The per-commit gate reviews only the new commit's diff, caps the rounds, and runs in the background.

## Plan format

```yaml
title: <Title>
goal: |
  <goal + baseline facts; the numbers that justify the splits>
base: release            # branch each phase is cut from
reviewBase: main         # the final branch-vs-base review compares against this
phases:
  - name: Phase 1 — <name>
    intent: |            # 1-2 lines: what this phase achieves + how it builds toward `goal`
      <why this phase>   # fed (with `goal`) to every item subagent for context
    items:
      - id: C1            # unique across the doc; used for branch/commit/resume
        done: false       # true only for already-done work the executor skips
        do: |
          <imperative scope — what to change and where>
        gate: <command → expected, e.g. `npm run lint` → 0 errors>
      - id: C2
        done: false
        do: |
          ...
        gate: ...
  - name: Phase 2 — <name>
    items:
      - id: C3
        done: false
        do: |
          ...
        gate: ...
excluded:
  - <choices, each with a one-line why>
```

Each item is one commit: independently committable, independently verifiable, small. Big buckets get
split by shared root cause or unit of delivery.

## License

MIT — see [LICENSE](./LICENSE).
