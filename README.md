# gated-plan-skills

Three composing [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by an AI code-review loop** — and, before
that, for deciding *what the work even is*. The model work is spread across an intelligence ladder
(kimi → minimax → sonnet → glm → gpt → opus): all but Claude run through the
[cline CLI](https://docs.cline.bot/usage/cli-overview); Claude uses the
[Claude Code CLI](https://code.claude.com/docs/en/cli-reference).

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-brainstorm` | `/gated-plan-brainstorm <topic>` | Runs a simulated design meeting on a subjective, open-ended topic: a chair casts a roster of deliberately-clashing personas (each backed by one difficulty-matched ladder model, read-only) and drives them through opening positions → debate rounds → convergence → an objections pass, then writes a decision brief to `docs/brainstorms/<topic>.md`. |
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. Takes a brainstorm brief or a raw task as input. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** (one commit each) — each item's impl/fix **delegated to a difficulty-sized coding agent** (ladder kimi → minimax → sonnet → glm → gpt → opus) — reviewed by one reviewer difficulty-matched one tier above the implementer on the same ladder (read-only, same quota/auth fallback) and loops fix→recommit→re-review until the commit is clean, then runs one final review of the whole branch vs `main`. |

They compose: **brainstorm → create → execute**. `brainstorm` is optional — start there when the
direction is still subjective; skip straight to `create` when the work is already concrete. The
coupling is light: `brainstorm` writes a markdown brief that `create` reads, and `create` emits
exactly the YAML schema `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do`
scope, a `gate`, and a `done` flag).

## Requirements

- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) (`claude`) — logged in. Used to run
  the skills, as the Claude Sonnet reviewer, and (write-capable, via `--permission-mode
  bypassPermissions`) as the `claude-sonnet-4-6` / `claude-opus-4-8` impl-and-fix tiers.
- [cline CLI](https://docs.cline.bot/usage/cli-overview) — **installed with these providers
  configured** (`cline auth`). Optional for `gated-plan-create` (an advisory plan-mode sounding board —
  gpt-5.5 / GLM-5.2 — it may consult on hard splitting calls; skipped if unconfigured).
  `gated-plan-execute` uses these
  for both **review** (plan mode, `-p`) and **implementation/fixes** (act mode — no `-p`,
  `--auto-approve` defaults true — so the agent edits files and commits). The reviewers use exactly one
  per review, picked by fallback order (first with quota):
  1. `cline -p -P openai-codex -m gpt-5.5`
  2. `cline -p -P zai-coding-plan -m glm-5.2`
  3. `claude -p --model claude-sonnet-4-6` (Claude Code CLI; spends your main Claude credits)
  4. `cline -p -P moonshot -m kimi-k2.7-code` (last)

  Implementation/fixes pick a model by the item's difficulty (1–5): `kimi-k2.7` · `claude-sonnet-4-6` ·
  `glm-5.2` · `gpt-5.5` · `claude-opus-4-8` (the two Claude tiers spend your main Claude credits). The
  skill never sets keys/models; it assumes cline's providers and `claude` are preconfigured, and
  invokes each by absolute path (the shell doesn't source `~/.zshrc`).
- `git` (work happens on real branches/commits).

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
ln -s "$PWD/gated-plan-skills/skills/gated-plan-create"     ~/.claude/skills/gated-plan-create
ln -s "$PWD/gated-plan-skills/skills/gated-plan-execute"    ~/.claude/skills/gated-plan-execute
```

Skills load at session start — start a fresh Claude Code session after installing.

## Usage

```
/gated-plan-brainstorm should we split the auth service out of the monolith?
#   → runs the meeting, writes docs/brainstorms/<topic>.md (skip this step if the work is already concrete)

/gated-plan-create add full test + lint + typecheck coverage to the app
#   → writes docs/plans/<name>.yaml (can take the brainstorm brief as input)

/gated-plan-execute docs/plans/<name>.yaml
#   → runs phase 1 (branch, commit each item, review-gated), reports, asks before the next phase
```

`gated-plan-execute` skips items already marked `done: true`, so re-invoking **resumes**.

## How the review gate works

For each item: a **delegated coding agent** — picked from the difficulty ladder (`kimi-k2.7` →
`claude-sonnet-4-6` → `glm-5.2` → `gpt-5.5` → `claude-opus-4-8`), run write-capable via cline act mode
or `claude --permission-mode bypassPermissions` — implements the item and commits. The workflow never
writes the code itself; it only rates difficulty and drives the loop. Then, **before** any review, a
read-only subagent re-runs the item's own `gate` (its `npm run lint` / `typecheck` / `test` command) on
the committed HEAD — a hard precondition. A red gate is fixed and re-verified first, so the reviewer never
sees a build that doesn't lint/typecheck/test green. Once the gate is green, a review subagent runs
**one reviewer** over the new commit — tried in fallback order, one at a time, using the first with
quota (never two at once). All are **agentic** — they run git and read the code themselves (not a diff
dumped into a prompt):

```
1. cline -p -P openai-codex   -m gpt-5.5         "<prompt>"    # gpt-5.5
2. cline -p -P zai-coding-plan -m glm-5.2        "<prompt>"    # GLM-5.2, Z.ai coding plan
3. claude -p "<prompt>" --model claude-sonnet-4-6 --allowedTools "Bash(git:*)" Read Grep Glob   # main credits
4. cline -p -P moonshot       -m kimi-k2.7-code  "<prompt>"    # last
```

`cline -p` runs in plan mode — it investigates but can't edit (cline's read-only equivalent of
Claude's `--allowedTools`). cline output is redirected to a temp file and the tail is read (no
`--json` — it would dump the whole event stream).

It reads the findings and returns them classified as **P1** (must-fix: bug, regression, security,
data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 → a delegated fix agent
addresses them and recommits → re-review. Fixes start at the item's impl tier and **escalate one tier
up the ladder per failed round** (capped at `claude-opus-4-8`). Capped at `maxRounds` (default 7).

After every item in the phase is clean, one **final review of the whole branch against `reviewBase`**
(same fallback order, against `git diff main...HEAD`) runs to catch cross-commit interactions the
per-commit gates can't see, loop-fixing up to 3 rounds. Anything still open lands in
`branchUnresolved`, surfaced before the merge decision.

A reviewer falls through to the next **only** when it can't review — out of credits/quota/rate-limit,
or (for cline) an auth/unauthenticated/expired-token error, which is how cline surfaces an exhausted
plan — not when it finds issues. If every reviewer is out of quota, the review returns a P1
"NO REVIEWER AVAILABLE" rather than a silent clean pass. All print text findings, so one classifier
handles them all.

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
