---
name: gated-plan-execute
description: Execute a commit-by-commit plan YAML phase-by-phase, each commit gated by a code-review loop plus a final branch-vs-main gate. Use when the user points at a plan YAML (e.g. docs/plans/*.yaml) and wants it built one item at a time, branched per phase from a base, each item implemented/fixed by the Cursor agent CLI (headless `-p --force`: auto-routed model, Cursor codebase index, writes + commits) and each commit reviewed by a separate read-only pass (`agent -p --trust`) looped until no P1/P2. Triggers on "run/execute this plan", "work the checklist with review", "/gated-plan-execute <doc>". Pairs with `gated-plan-create`, which produces the YAML this skill consumes.
---

# gated-plan-execute

Drive a commit-level plan YAML to done: per phase, branch from a base, do each item **sequentially**
(one commit each), gate every commit on a review loop until no P1/P2, then gate the **whole branch
against `main`** before merge. Each item's implementation/fix is **delegated to the Cursor `agent`
CLI** (headless, write-capable: `-p --force` — Cursor auto-routes a model, uses its codebase index,
edits files, and makes the commit) — the workflow never re-spawns itself to write code. Review is a
**separate read-only pass** by the same agent (`-p --trust`, no `--force` — it investigates but cannot
edit). The deterministic loop lives in the bundled workflow `phase-review-loop.js` (next to this
file); this skill parses the YAML and drives it phase-by-phase.

## Inputs
- **Required:** path to the plan YAML (the skill argument). If none given, ask for it.
- **Optional:** a phase selector (e.g. "Phase 2" or "all"). `base`/`reviewBase` come
  from the YAML but a user-given value overrides.

## Procedure

1. **Read the YAML.** `Read` the referenced file and parse it as YAML. Top-level keys: `title`,
   `goal`, `base`, `reviewBase`, `phases[]`, `excluded[]`. Each phase has `name`, `intent`, and
   `items[]`; each item has `id`, `done`, `do`, `gate`. Honor the doc's `base`/`reviewBase` over the
   workflow defaults. `goal` and the phase `intent` are the bigger-picture context fed to each item
   subagent (below).

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
       goal: '<yaml goal>',                             // bigger-picture context for every item subagent
       phaseIntent: '<phase.intent>',                   // how this phase fits the goal
       branch: 'phase/<n>-<kebab-of-phase-name>',
       base: '<yaml base, default release>',
       reviewBase: '<yaml reviewBase, default main>',   // the final branch gate reviews against this
       maxRounds: 7,
       items: [ /* from step 3 */ ]
     }
   })
   ```

   The workflow runs in the background and returns `{ branch, itemsDone, unresolved, branchUnresolved }`.
   The per-commit gate reviews only the new commit's diff to keep it minimal. Reviews run in the
   background regardless. Do NOT shrink `maxRounds` below 2.

   **Per-round gate precondition.** Each round the workflow first re-runs the item's `gate` on the
   committed HEAD (a separate read-only agent — runs the lint/typecheck/test it names, edits nothing).
   A red gate is fixed and re-verified *before* any review, so the reviewer never sees a build that
   doesn't lint/typecheck/test green. An item whose gate never goes green within `maxRounds` lands in
   `unresolved` with a `gate never green` blocker — it is never reported done.

   **Two review stages.** Per-commit review gates each commit inside the item loop. After all items, a
   **final branch-vs-`reviewBase` review** runs to catch cross-commit interactions, loop-fixing up to 3
   rounds; anything still flagged returns in `branchUnresolved`.

   **Review = a separate read-only pass.** Each review is **one** reviewer: the Cursor agent run
   read-only (`-p --trust`, no `--force` — it investigates via git/reads but cannot apply edits). It is
   not the invocation that wrote the code, and it auto-routes its own model and uses Cursor's codebase
   index, so the workflow does NOT pre-dump a diff — let it explore (a real review, not a skim). **No
   `--json`** (output defaults to final-answer-only text); the command redirects to a temp file and the
   subagent reads the `tail`. If the agent can't run (connection lost / max retries / quota / auth), the
   subagent returns a P1 "NO REVIEWER AVAILABLE" rather than a silent clean pass.

   **Implementation & fix delegation.** The workflow does NOT implement items itself — each impl/fix is
   handed to the Cursor agent in **write mode** (`-p --force`: Cursor auto-routes a model, edits files,
   and makes the commit itself). The task text is passed via a temp file so backticks/`$`/quotes survive
   intact. An impl run that **ran but left no commit** is the agent's turn — the gate/fix loop handles
   it, not a re-run; only if the agent is **unavailable** (connection/quota/auth) is the item left for
   retry (gate goes red). The binary is invoked by **absolute path** (`/Users/mradul/.local/bin/agent`;
   the shell doesn't source `~/.zshrc`). **Assume the Cursor agent is configured and logged in**
   (`CURSOR_API_KEY` or a stored login) — never prompt for or set keys/models during execution; Cursor
   picks the model. Setup is in the README.

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
  Keep each delegated impl/fix scoped to a single item.
- Impl/fix are **delegated to the Cursor agent CLI** (write mode), not the orchestrator itself; the
  orchestrator only classifies reviews and drives the loop.
- Sequential only (no parallel item agents) — they share the working tree.
- The review subagent **runs ONE read-only reviewer (the Cursor agent, `-p --trust`) and classifies**;
  it never edits. Fixes are a separate subagent.
- Verify, don't assume: if a gate (`lint`/`typecheck`/`test`) isn't green, the item isn't done.
- Surface blockers and merge/push decisions to the human; make only the small calls yourself.
