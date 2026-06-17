# gated-plan-skills

Two paired [Claude Code](https://claude.com/claude-code) skills for shipping work as a series of
small, independently-verifiable commits — each one **gated by an AI code-review loop**
([OCR](https://github.com/alibaba/open-code-review)+GLM, falling back to
[codex](https://github.com/openai/codex)) until there are no P1/P2 findings.

| Skill | Invoke | Does |
|---|---|---|
| `gated-plan-create` | `/gated-plan-create <task>` | Measures the real work, splits it into commit-sized items grouped into phases (each item names its verification gate), and writes a plan to `docs/plans/<name>.yaml`. |
| `gated-plan-execute` | `/gated-plan-execute <doc>` | Branches per phase from a base, does each item **sequentially** via a subagent (one commit each), reviews with OCR+GLM and loops fix→recommit→re-review until the commit is clean, then runs one final review of the whole branch vs `main`. Falls back to `codex exec review` when OCR is out of credits. |

The two compose: **create → execute**. The only coupling is the YAML schema — `create` emits exactly
what `execute` parses (`phases[]` of `items[]`; each item a unique `id`, a `do` scope, a `gate`, and
a `done` flag).

## Requirements

- [Claude Code](https://claude.com/claude-code).
- [`ocr`](https://github.com/alibaba/open-code-review) (`npm i -g @alibaba-group/open-code-review`)
  configured against GLM — the primary reviewer for `gated-plan-execute`. Point it at the **GLM Coding
  Plan** endpoint/key via `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL` so it bills the
  subscription, not pay-per-token. (Not needed for `gated-plan-create`.)
- *Fallback:* the [`codex` CLI](https://github.com/openai/codex) on `PATH`, authenticated — used
  automatically only when OCR/GLM is out of credits. `gated-plan-execute` shells out to
  `codex exec review`.
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

For each item: an impl subagent commits the work. Then, **before** any review, a read-only
subagent re-runs the item's own `gate` (its `npm run lint` / `typecheck` / `test` command) on the
committed HEAD — a hard precondition. A red gate is fixed and re-verified first, so the reviewer never
sees a build that doesn't lint/typecheck/test green. Once the gate is green, a review subagent runs

```
ocr review --commit HEAD             # the new commit's diff only — fastest
# or --from main --to <branch> for the whole branch vs a base
```

reads the findings, and returns them classified as **P1** (must-fix: bug, regression, security,
data loss, broken gate) / **P2** (should-fix) / ignore (nits, style). Any P1/P2 → a fix subagent
addresses them and recommits → re-review. Capped at `maxRounds` (default 7).

After every item in the phase is clean, one **final review of the whole branch against `reviewBase`**
(`ocr review --from main --to <branch>`) runs to catch cross-commit interactions the per-commit gates
can't see, loop-fixing up to 3 rounds. Anything still open lands in `branchUnresolved`, surfaced
before the merge decision.

**OCR out of credits?** Each review runs OCR (pointed at GLM's Coding Plan) first; only if OCR/GLM
fails *because it's out of credits/quota* does the same review re-run with
[`codex exec review`](https://github.com/openai/codex) (`--commit HEAD` / `--base main`). Both print
text findings, so the same classifier handles either, and the switch costs nothing while OCR is
healthy.

> The codex *fallback* is thorough but **slow** (~4–8 min per commit); OCR is faster. Either way the
> per-commit gate reviews only the new commit's diff, caps the rounds, and runs in the background. An
> optional `codexModel` arg points the codex fallback at a faster model.

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
