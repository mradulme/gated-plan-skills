---
name: gated-plan-create
description: Turn a task/spec into a commit-level plan YAML that `gated-plan-execute` can run. Use when the user wants to plan work as a checklist of small, independently-shippable commits grouped into phases — each item naming its verification gate — for codex-gated execution. Triggers on "create a gated plan", "plan this for gated execution", "write a commit-by-commit plan", "/gated-plan-create <task>". Pairs with `gated-plan-execute`, which consumes the YAML this skill writes.
---

# gated-plan-create

Produce a `docs/plans/<name>.yaml` whose every item is **one self-contained, independently-green
commit**, grouped into phases, each item naming the gate that proves it done. The output is the
exact contract `gated-plan-execute` reads, so the two compose: create → execute.

## Procedure

1. **Understand the task.** If the ask is fuzzy or design-level, run the `brainstorming` skill
   first. Don't plan past real ambiguity — ask.

2. **Get ground truth, don't guess.** Run the relevant read-only diagnostics so item sizing is
   real, not imagined: counts and concrete lists (e.g. `tsc --noEmit | grep -c error`, the failing
   files, a coverage report, the route inventory). Splitting a bucket you haven't measured produces
   fake granularity.

3. **Decide phases + conventions.** Group items into logical phases (cheap gates first, foundations
   before dependents). Pick and **set in the YAML top-level keys**: `base` (branch to cut from,
   default `release`), `reviewTarget`/`reviewBase` (what codex reviews against, default the new
   commit vs `main`), and any deliberate `excluded` choices. Surface only genuine forks to the user;
   default the rest.

4. **Split into commit-sized items.** This is the core skill. Each item is:
   - **independently committable** — touches one concern; doesn't half-break another,
   - **independently verifiable** — names its gate / done-when (a command that goes green),
   - **small** — a big bucket (N errors, a large feature) MUST be broken down, ideally by
     **shared root cause** (e.g. "120 type errors → 6 clusters by the module they live in") or by
     **unit of delivery** (e.g. "a new feature → one capability per commit, then one e2e flow per
     commit"). If you can't name the gate, the item is too vague.

5. **Write the YAML** in the schema below to `docs/plans/<kebab-name>.yaml`. Then tell the user to
   run `gated-plan-execute docs/plans/<file>.yaml`. Don't start implementing — this skill only plans.

## YAML schema (what `gated-plan-execute` parses)

```yaml
title: <Title>
goal: |
  <goal + baseline facts from step 2 — the numbers that justify the splits>
base: release            # branch each phase is cut from
reviewTarget: commit     # commit = new commit only (fast) | base = whole branch vs reviewBase
reviewBase: main         # what `reviewTarget: base` compares against
phases:
  - name: Phase 1 — <name>
    items:
      - id: C1            # unique label across the whole doc; used for branch/commit/resume
        done: false       # true only for already-done work
        do: |
          <imperative scope — what to change and in which files>
        gate: <command → expected result, e.g. `npm run lint` → 0 errors>
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
  - <choice not oversight — the one-line why>
```

Rules the schema must satisfy (the executor relies on them):
- `phases` is an ordered list; each has a `name` and an ordered `items` list.
- Every item has a unique `id` (`C1`, `C-E1`, …) — that's its handle for branch/commit naming and
  resume. `done: false` is the default; `done: true` marks already-finished work the executor skips.
- Each item is **one commit**: a single `do` scope plus exactly one `gate`. No "and also" items that
  bundle unrelated changes — split them.
- `do` is imperative and self-contained (the executor hands it straight to an impl subagent, which
  does NOT re-read this file).
- `gate` MUST be a **literal runnable check** — the executor actually runs it on the committed HEAD
  as a hard precondition and only spawns the codex review once it passes. Name the exact command and
  its pass condition (e.g. `` `npm run lint` → 0 errors ``, `` `npm test` green ``,
  `` `npm run typecheck` → 0 ``). Prefer the project's standard lint/typecheck/test commands. A gate
  that can't be run as a command (e.g. "looks good", "manually verify") defeats the precondition —
  if a step is truly only checkable by eye, mark it `do`-only and say so, don't fake a gate.

## Guardrails
- Measure before you split (step 2). Granularity must reflect real work, not padding.
- Order for dependencies: if Phase B needs a script/type/flag from Phase A, A comes first.
- List deliberate simplifications under `excluded` — a skipped thing named is a decision; unnamed is
  a gap.
- Valid YAML only: quote any `do`/`gate` value containing `:` followed by a space, or use the `|`
  block scalar (preferred for multi-line scope). This is the contract — a parse error blocks execute.
- This skill writes a plan and stops. Execution is `gated-plan-execute`.
