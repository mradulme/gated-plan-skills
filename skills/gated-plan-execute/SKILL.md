---
name: gated-plan-execute
description: Execute a commit-by-commit plan YAML phase-by-phase, each commit gated by a codex review loop. Use when the user points at a plan YAML (e.g. docs/plans/*.yaml) and wants it built one item at a time, branched per phase from a base, with each commit reviewed by `codex exec review` and looped until no P1/P2. Triggers on "run/execute this plan", "work the checklist with codex review", "/gated-plan-execute <doc>". Pairs with `gated-plan-create`, which produces the YAML this skill consumes.
---

# gated-plan-execute

Drive a commit-level plan YAML to done: per phase, branch from a base, do each item **sequentially**
via a subagent (one commit each), then gate every commit on a `codex exec review` loop until it
reports no P1/P2. The deterministic loop lives in the bundled workflow `phase-review-loop.js` (next
to this file); this skill parses the YAML and drives it phase-by-phase.

## Inputs
- **Required:** path to the plan YAML (the skill argument). If none given, ask for it.
- **Optional:** a phase selector (e.g. "Phase 2" or "all"). `base`/`reviewTarget`/`reviewBase`/
  `codexModel` come from the YAML but a user-given value overrides.

## Procedure

1. **Read the YAML.** `Read` the referenced file and parse it as YAML. Top-level keys: `title`,
   `goal`, `base`, `reviewTarget`, `reviewBase`, `phases[]`, `excluded[]`. Each phase has `name` and
   `items[]`; each item has `id`, `done`, `do`, `gate`. Honor the doc's `base`/`reviewTarget`/
   `reviewBase` over the workflow defaults.

2. **Pick the target phase.** Default to the **first phase that still has an item with `done: false`**
   (so re-invoking resumes). If the user named a phase, use it. If they said "all", process phases in
   order, pausing for the merge decision (step 5) between each.

3. **Build the items list** for that phase — one entry per item where `done` is not `true`:
   `{ label: item.id, prompt: item.do + "\n\nGate: " + item.gate }`.
   Skip items already marked `done: true`.

4. **Run the phase** via the bundled workflow (this is the explicit opt-in to call `Workflow`).
   Pass `args` as an actual JSON object, not a string:

   ```
   Workflow({
     scriptPath: '<absolute path to phase-review-loop.js beside this SKILL.md>',
     args: {
       phaseTitle: '<phase.name>',
       branch: 'phase/<n>-<kebab-of-phase-name>',
       base: '<yaml base, default release>',
       reviewTarget: '<yaml reviewTarget, default commit>',   // 'base' = full branch vs reviewBase (slower)
       reviewBase: '<yaml reviewBase, default main>',
       maxRounds: 3,
       // codexModel: '<faster model>',   // optional speed knob
       items: [ /* from step 3 */ ]
     }
   })
   ```

   The workflow runs in the background and returns `{ branch, itemsDone, unresolved }`.
   `codex exec review` is slow (4–8 min/commit) — that's expected; `reviewTarget:'commit'`
   keeps each review's diff minimal. Do NOT shrink `maxRounds` below 2.

5. **After the phase completes:**
   - Set `done: true` on the now-finished items in the YAML and commit that doc update.
   - Report `unresolved` (items still carrying P1/P2 after `maxRounds`) plainly — do not hide them;
     leave their `done: false`.
   - Present the phase branch and **ask** whether to merge it into the base before the next phase
     (later phases often depend on earlier ones — e.g. a `verify` script needing a `typecheck`
     script). Use the finishing-a-development-branch flow. Never auto-merge or auto-push.

6. **Continue** to the next phase (step 2) only after the merge decision, or stop if the user
   wanted a single phase.

## Guardrails
- One item = one commit = one review gate. Keep impl subagents scoped to a single item.
- Sequential only (no parallel item agents) — they share the working tree.
- The review subagent **runs codex and classifies**; it never edits. Fixes are a separate subagent.
- Verify, don't assume: if a gate (`lint`/`typecheck`/`test`) isn't green, the item isn't done.
- Surface blockers and merge/push decisions to the human; make only the small calls yourself.
