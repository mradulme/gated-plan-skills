# gated-plan-skills

Two paired [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by a [codex](https://github.com/openai/codex)
review loop** until there are no P1/P2 findings.

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** via a subagent (one commit each), then runs `codex exec review` and loops fix→recommit→re-review until the commit is clean. |

The two compose: **create → execute**. The only coupling is the YAML schema — `create` emits exactly
what `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do` scope, a `gate`, and
a `done` flag).

## Requirements

- [Claude Code](https://claude.com/claude-code).
- The [`codex` CLI](https://github.com/openai/codex) on `PATH`, authenticated — `gated-plan-execute`
  shells out to `codex exec review` for the review gate. (Not needed for `gated-plan-create`.)
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
#   → runs phase 1 (branch, commit each item, codex-gated), reports, asks before the next phase
```

`gated-plan-execute` skips items already marked `done: true`, so re-invoking **resumes**.

## How the review gate works

For each item: an impl subagent commits the work, then a review subagent runs

```
codex exec review --commit HEAD      # the new commit's diff only — fastest
# or --base <branch> for the whole branch vs a base
```

reads codex's findings, and returns them classified as **P1** (must-fix: bug, regression, security,
data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 → a fix subagent
addresses them and recommits → re-review. Capped at `maxRounds` (default 7).

> `codex exec review` is thorough but **slow** (~4–8 min per commit). Defaults are tuned for this:
> reviews only the new commit's diff, caps the rounds, and runs the whole thing in the background.
> An optional `codexModel` arg lets you point the review at a faster model.

## Plan format

```yaml
title: <Title>
goal: |
  <goal + baseline facts; the numbers that justify the splits>
base: release            # branch each phase is cut from
reviewTarget: commit     # commit = new commit only (fast) | base = whole branch vs reviewBase
reviewBase: main
phases:
  - name: Phase 1 — <name>
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
