# gated-plan-skills

Two paired [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by an AI code-review loop** that tries a
chain of reviewers ([codex](https://github.com/openai/codex) → GLM-5.2 via
[opencode](https://github.com/sst/opencode) → Kimi → Claude Sonnet, using the first with quota) until
there are no P1/P2 findings.

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** via a subagent (one commit each), reviews via the reviewer chain (codex → GLM-5.2/opencode → Kimi → Claude Sonnet) and loops fix→recommit→re-review until the commit is clean, then runs one final review of the whole branch vs `main`. |

The two compose: **create → execute**. The only coupling is the YAML schema — `create` emits exactly
what `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do` scope, a `gate`, and
a `done` flag).

## Requirements

- [Claude Code](https://claude.com/claude-code).
- The reviewer chain for `gated-plan-execute`, each **installed and logged in** (not needed for
  `gated-plan-create`). The chain is tried in order, using the first with quota:
  1. [`codex`](https://github.com/openai/codex), authenticated.
  2. [`opencode`](https://github.com/sst/opencode) configured to use **GLM-5.2** on Z.ai's coding
     plan (GLM has no native CLI).
  3. [`kimi`](https://github.com/MoonshotAI/kimi-cli) — Kimi's native CLI, on its coding plan.
  4. [`claude`](https://claude.com/claude-code) — uses `claude -p --model claude-sonnet-4-6` (last;
     spends your main Claude credits).

  The skill never sets keys/models; it assumes these are preconfigured, and invokes each by absolute
  path (the review shell doesn't source `~/.zshrc`).
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
ln -s "$PWD/gated-plan-skills/skills/gated-plan-create"  ~/.claude/skills/gated-plan-create
ln -s "$PWD/gated-plan-skills/skills/gated-plan-execute" ~/.claude/skills/gated-plan-execute
```

Skills load at session start — start a fresh Claude Code session after installing.

## Usage

```
/gated-plan-create add full test + lint + typecheck coverage to the app
#   → writes docs/plans/<name>.yaml

/gated-plan-execute docs/plans/<name>.yaml
#   → runs phase 1 (branch, commit each item, review-gated), reports, asks before the next phase
```

`gated-plan-execute` skips items already marked `done: true`, so re-invoking **resumes**.

## How the review gate works

For each item: an impl subagent commits the work. Then, **before** any review, a read-only
subagent re-runs the item's own `gate` (its `npm run lint` / `typecheck` / `test` command) on the
committed HEAD — a hard precondition. A red gate is fixed and re-verified first, so the reviewer never
sees a build that doesn't lint/typecheck/test green. Once the gate is green, a review subagent runs the
**reviewer chain** over the new commit, one at a time in order, using the first with quota. All are
**agentic** — they run git and read the code themselves (not a diff dumped into a prompt):

```
1. codex exec review --commit HEAD                            # slow
2. opencode run "<prompt>" -m zai-coding-plan/glm-5.2          # GLM-5.2, Z.ai coding plan
3. kimi -p "<prompt>"                                          # Kimi coding plan
4. claude -p "<prompt>" --model claude-sonnet-4-6 --allowedTools "Bash(git:*)" Read Grep Glob   # last; main credits
```

It reads the findings and returns them classified as **P1** (must-fix: bug, regression, security,
data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 → a fix subagent
addresses them and recommits → re-review. Capped at `maxRounds` (default 7).

After every item in the phase is clean, one **final review of the whole branch against `reviewBase`**
(same chain, against `git diff main...HEAD` / `codex exec review --base main`) runs to catch
cross-commit interactions the per-commit gates can't see, loop-fixing up to 3 rounds. Anything still
open lands in `branchUnresolved`, surfaced before the merge decision.

A reviewer is skipped to the next **only** when it's out of credits/quota/rate-limit/auth — not when
it finds issues. All print text findings, so one classifier handles them all.

> codex (tried first) is thorough but **slow** (~4–8 min per commit); GLM/Kimi are faster. Either
> way the per-commit gate reviews only the new commit's diff, caps the rounds, and runs in the
> background. An optional `codexModel` arg points the codex step at a faster model.

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
