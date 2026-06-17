---
name: gated-plan-execute
description: Execute a commit-by-commit plan YAML phase-by-phase, each commit gated by a code-review loop plus a final branch-vs-main gate. Use when the user points at a plan YAML (e.g. docs/plans/*.yaml) and wants it built one item at a time, branched per phase from a base, with each commit reviewed by OCR+GLM (falling back to `codex exec review` when OCR is out of credits) and looped until no P1/P2. Triggers on "run/execute this plan", "work the checklist with codex review", "/gated-plan-execute <doc>". Pairs with `gated-plan-create`, which produces the YAML this skill consumes.
---

# gated-plan-execute

Drive a commit-level plan YAML to done: per phase, branch from a base, do each item **sequentially**
via a subagent (one commit each), gate every commit on a review loop until no P1/P2, then gate the
**whole branch against `main`** before merge. Review is by OCR (Alibaba open-code-review) + GLM (the
cheap Coding Plan), falling back to `codex exec review` when OCR/GLM is out of credits. The
deterministic loop lives in the bundled workflow `phase-review-loop.js` (next to this file); this
skill parses the YAML and drives it phase-by-phase.

## Inputs
- **Required:** path to the plan YAML (the skill argument). If none given, ask for it.
- **Optional:** a phase selector (e.g. "Phase 2" or "all"). `base`/`reviewBase`/`codexModel` come
  from the YAML but a user-given value overrides.

## Procedure

1. **Read the YAML.** `Read` the referenced file and parse it as YAML. Top-level keys: `title`,
   `goal`, `base`, `reviewBase`, `phases[]`, `excluded[]`. Each phase has `name` and
   `items[]`; each item has `id`, `done`, `do`, `gate`. Honor the doc's `base`/`reviewBase` over the
   workflow defaults.

2. **Pick the target phase.** Default to the **first phase that still has an item with `done: false`**
   (so re-invoking resumes). If the user named a phase, use it. If they said "all", process phases in
   order, pausing for the merge decision (step 5) between each.

3. **Build the items list** for that phase — one entry per item where `done` is not `true`:
   `{ label: item.id, prompt: item.do + "\n\nGate: " + item.gate, gate: item.gate }`.
   Pass `gate` as its own field too — the workflow re-runs it on HEAD as a **hard precondition**
   each round and only spawns the reviewer once it's green (see below). Skip items already `done: true`.

4. **Run the phase** via the bundled workflow (this is the explicit opt-in to call `Workflow`).
   Pass `args` as an actual JSON object, not a string:

   ```
   Workflow({
     scriptPath: '<absolute path to phase-review-loop.js beside this SKILL.md>',
     args: {
       phaseTitle: '<phase.name>',
       branch: 'phase/<n>-<kebab-of-phase-name>',
       base: '<yaml base, default release>',
       reviewBase: '<yaml reviewBase, default main>',   // the final branch gate reviews against this
       maxRounds: 7,
       // codexModel: '<faster model>',   // optional speed knob
       items: [ /* from step 3 */ ]
     }
   })
   ```

   The workflow runs in the background and returns `{ branch, itemsDone, unresolved, branchUnresolved }`.
   The per-commit gate reviews only the new commit's diff to keep it minimal. Reviews run in the
   background regardless; the codex *fallback* is slow (4–8 min/commit), OCR is faster. Do NOT shrink
   `maxRounds` below 2.

   **Per-round gate precondition.** Each round the workflow first re-runs the item's `gate` on the
   committed HEAD (a separate read-only agent — runs the lint/typecheck/test it names, edits nothing).
   A red gate is fixed and re-verified *before* any review, so the reviewer never sees a build that
   doesn't lint/typecheck/test green. An item whose gate never goes green within `maxRounds` lands in
   `unresolved` with a `gate never green` blocker — it is never reported done.

   **Two review stages.** Per-commit (`ocr review --commit HEAD`) gates each commit inside the item
   loop. After all items, a **final branch-vs-`reviewBase` review** (`ocr review --from <reviewBase>
   --to <branch>`) runs to catch cross-commit interactions, loop-fixing up to 3 rounds; anything still
   flagged returns in `branchUnresolved`.

   **OCR is primary; codex is the fallback (automatic).** OCR + GLM is the cheap Coding-Plan
   subscription, so each review subagent runs OCR first and, only if OCR/GLM is out of
   credits/quota/rate-limit, re-runs the same review with `codex exec review --commit HEAD` /
   `--base <reviewBase>`. Both print text findings, so the same classifier handles either. The switch
   is automatic and costs nothing while OCR is healthy. **Assume `ocr` is already installed and
   configured against GLM** (env set out of band) — never prompt for or set its key/model/endpoint
   during execution; the workflow only ever runs `ocr review ...`. One-time setup lives in the README.

5. **After the phase completes:**
   - Set `done: true` on the now-finished items in the YAML and commit that doc update.
   - Report `unresolved` (items still carrying P1/P2 after `maxRounds`) and `branchUnresolved`
     (branch-vs-`reviewBase` findings still open after 3 rounds) plainly — do not hide them;
     leave affected items `done: false`.
   - Present the phase branch and **ask** whether to merge it into the base before the next phase
     (later phases often depend on earlier ones — e.g. a `verify` script needing a `typecheck`
     script). Use the finishing-a-development-branch flow. Never auto-merge or auto-push.

6. **Continue** to the next phase (step 2) only after the merge decision, or stop if the user
   wanted a single phase.

## Guardrails
- One item = one commit = one review gate; the branch then gets one final review vs `reviewBase`.
  Keep impl subagents scoped to a single item.
- Sequential only (no parallel item agents) — they share the working tree.
- The review subagent **runs the reviewer (OCR, or codex on credit fallback) and classifies**; it
  never edits. Fixes are a separate subagent.
- Verify, don't assume: if a gate (`lint`/`typecheck`/`test`) isn't green, the item isn't done.
- Surface blockers and merge/push decisions to the human; make only the small calls yourself.
