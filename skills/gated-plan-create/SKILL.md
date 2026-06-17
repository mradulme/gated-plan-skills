---
name: gated-plan-create
description: Turn a task/spec into a commit-level plan doc that `gated-plan-execute` can run. Use when the user wants to plan work as a checklist of small, independently-shippable commits grouped into phases — each item naming its verification gate — for codex-gated execution. Triggers on "create a gated plan", "plan this for gated execution", "write a commit-by-commit plan", "/gated-plan-create <task>". Pairs with `gated-plan-execute`, which consumes the doc this skill writes.
---

# gated-plan-create

Produce a `docs/plans/<name>.md` whose every checkbox is **one self-contained, independently-green
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
   before dependents). Pick and **state in the doc**: the base branch to cut from (default
   `release`), what codex reviews against (default the new commit), and any deliberate exclusions.
   Surface only genuine forks to the user; default the rest.

4. **Split into commit-sized items.** This is the core skill. Each item is:
   - **independently committable** — touches one concern; doesn't half-break another,
   - **independently verifiable** — names its gate / done-when (a command that goes green),
   - **small** — a big bucket (N errors, a large feature) MUST be broken down, ideally by
     **shared root cause** (e.g. "120 type errors → 6 clusters by the module they live in") or by
     **unit of delivery** (e.g. "a new feature → one capability per commit, then one e2e flow per
     commit"). If you can't name the gate, the item is too vague.

5. **Write the doc** in the format below to `docs/plans/<kebab-name>.md`. Then tell the user to run
   `gated-plan-execute docs/plans/<file>.md`. Don't start implementing — this skill only plans.

## Doc format (what `gated-plan-execute` parses)

```markdown
# <Title> — commit-level execution checklist

<1-3 lines: goal + baseline facts from step 2. State base branch + review convention.>

## Phase 1 — <name> (<n> commits)
- [ ] **C1** <imperative scope>. <files touched>. <gate: e.g. `npm run lint` → 0 errors>.
- [ ] **C2** ...

## Phase 2 — <name> (<n> commits)
- [ ] **C3** ...

## Deliberately excluded
<choices not oversights, each with the one-line why.>
```

Rules the format must satisfy (the executor relies on them):
- Phases are `##` headings; items are `- [ ]` boxes (use `- [x]` only for already-done work).
- Each item starts with a **bold label** (`**C1**`, `**C-E1**`, …) — that's its id for branch/commit
  naming and resume. Labels unique across the doc.
- Each item is one commit. No "and also" items that bundle unrelated changes.
- Keep it scannable: one line per commit where possible; sub-bullets only for a genuine file list.

## Guardrails
- Measure before you split (step 2). Granularity must reflect real work, not padding.
- Order for dependencies: if Phase B needs a script/type/flag from Phase A, A comes first.
- Mark deliberate simplifications/exclusions — a skipped thing named is a decision; unnamed is a gap.
- This skill writes a plan and stops. Execution is `gated-plan-execute`.
