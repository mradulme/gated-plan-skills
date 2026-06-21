# gated-plan-skills

Three composing [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by an AI code-review loop** — and, before
that, for deciding *what the work even is*. All the model work — implementation, fixes, review, and
brainstorm personas — runs through the [Cursor `agent` CLI](https://cursor.com/docs/cli/overview) in
headless mode, which auto-routes each task to a model and grounds it in Cursor's codebase index.

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-brainstorm` | `/gated-plan-brainstorm <topic>` | Runs a simulated design meeting on a subjective, open-ended topic: a chair casts a roster of deliberately-clashing personas (each voiced by the read-only Cursor agent) and drives them through opening positions → debate rounds → convergence → an objections pass, then writes a decision brief to `docs/brainstorms/<topic>.md`. |
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. Takes a brainstorm brief or a raw task as input. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** (one commit each) — each item's impl/fix **delegated to the Cursor agent** (headless `-p --force`: auto-routed, writes + commits) — reviewed by a separate read-only pass (`agent -p --trust`) that loops fix→recommit→re-review until the commit is clean, then runs one final review of the whole branch vs `main`. |

They compose: **brainstorm → create → execute**. `brainstorm` is optional — start there when the
direction is still subjective; skip straight to `create` when the work is already concrete. The
coupling is light: `brainstorm` writes a markdown brief that `create` reads, and `create` emits
exactly the YAML schema `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do`
scope, a `gate`, and a `done` flag).

## Requirements

- [Cursor `agent` CLI](https://cursor.com/docs/cli/overview) — installed and authenticated
  (`CURSOR_API_KEY` or a stored login). All three skills drive it headless: **review** and brainstorm
  **personas** run it read-only (`-p --trust`, no `--force` — it investigates via git/reads but applies
  no edits), and `gated-plan-execute` runs **implementation/fixes** write-capable (`-p --force` — it
  edits files and commits). No model is pinned — Cursor auto-routes and uses its codebase index.
  `gated-plan-create` may also consult it as an advisory read-only sounding board on hard splitting
  calls (skipped if unavailable). The skill never sets keys/models; it assumes the agent is
  preconfigured and invokes it by absolute path (`/Users/mradul/.local/bin/agent`; the shell doesn't
  source `~/.zshrc`).
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) (`claude`) — logged in. Runs the
  skills themselves (the orchestrating session).
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

For each item: the **Cursor agent** (headless, write-capable — `-p --force`, auto-routed) implements
the item and commits. The workflow never writes the code itself; it only drives the loop. Then,
**before** any review, a read-only subagent re-runs the item's own `gate` (its `npm run lint` /
`typecheck` / `test` command) on the committed HEAD — a hard precondition. A red gate is fixed and
re-verified first, so the reviewer never sees a build that doesn't lint/typecheck/test green. Once the
gate is green, a review subagent runs **one read-only reviewer** over the new commit:

```
/Users/mradul/.local/bin/agent -p --trust "<prompt>" > /tmp/gpe-…txt 2>&1; tail -n 120 /tmp/gpe-…txt
```

The reviewer is **agentic and read-only** — `-p --trust` (no `--force`) lets it run git and read the
code itself (not a diff dumped into a prompt), but it applies no edits. Output defaults to
final-answer-only text (no `--json`); it's redirected to a temp file and the tail is read.

It reads the findings and returns them classified as **P1** (must-fix: bug, regression, security,
data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 → a delegated fix agent
(`-p --force`) addresses them and recommits → re-review. Capped at `maxRounds` (default 7).

After every item in the phase is clean, one **final review of the whole branch against `reviewBase`**
(against `git diff main...HEAD`) runs to catch cross-commit interactions the per-commit gates can't
see, loop-fixing up to 3 rounds. Anything still open lands in `branchUnresolved`, surfaced before the
merge decision.

If the agent can't run (connection lost / max retries / quota / auth), the review returns a P1
"NO REVIEWER AVAILABLE" rather than a silent clean pass.

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
