---
name: gated-plan-execute
description: Execute a commit-by-commit plan YAML phase-by-phase, each commit gated by a code-review loop plus a final branch-vs-main gate. Use when the user points at a plan YAML (e.g. docs/plans/*.yaml) and wants it built one item at a time, branched per phase from a base, with each commit reviewed by one reviewer (fallback order gpt-5.5 → GLM-5.2 → Claude Sonnet → Kimi, via cline except Claude, using the first with quota) and looped until no P1/P2. Triggers on "run/execute this plan", "work the checklist with review", "/gated-plan-execute <doc>". Pairs with `gated-plan-create`, which produces the YAML this skill consumes.
---

# gated-plan-execute

Drive a commit-level plan YAML to done: per phase, branch from a base, do each item **sequentially**
via a subagent (one commit each), gate every commit on a review loop until no P1/P2, then gate the
**whole branch against `main`** before merge. Review uses **one reviewer**, picked by fallback order —
**gpt-5.5 → GLM-5.2 → Claude Sonnet → Kimi** (all via [cline](https://docs.cline.bot/usage/cli-overview)
except Claude, which uses the [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)) — the
first with quota; the next is tried only if that one can't review (never two at once). The
deterministic loop lives in the bundled workflow `phase-review-loop.js` (next to this file); this
skill parses the YAML and drives it phase-by-phase.

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

   **Reviewer fallback order.** Each review uses exactly **one** reviewer. The subagent tries them in
   order, runs **one at a time** (no parallel Bash calls, never stacked), classifies the first that
   produces a review and **stops** — falling through to the next ONLY when the current one can't review
   (out of credits/quota/rate-limit, or — for cline — an auth/unauthenticated/expired-token error,
   which is how cline surfaces an exhausted plan):

   1. **gpt-5.5** — `cline -p -P openai-codex -m gpt-5.5 "<review prompt>"`.
   2. **GLM-5.2** — `cline -p -P zai-coding-plan -m glm-5.2 "<review prompt>"`.
   3. **Claude Sonnet** (spends main-loop Claude credits) — `claude -p "<review prompt>"
      --model claude-sonnet-4-6 --allowedTools "Bash(git:*)" "Read" "Grep" "Glob"` (read-only whitelist
      so it can't edit).
   4. **Kimi** (last) — `cline -p -P moonshot -m kimi-k2.7-code "<review prompt>"`.

   `cline -p` is **plan mode** — it investigates (git, file reads) but structurally cannot edit, the
   cline equivalent of Claude's read-only `--allowedTools`. **No `--json`** (it re-emits every event —
   token bloat); each cline command redirects to a temp file and the subagent reads the `tail`. If
   every reviewer is out of quota/auth, the subagent returns a P1 "NO REVIEWER AVAILABLE" rather than a
   silent clean pass.

   All are **agentic** — they run git and read surrounding code themselves; the workflow does NOT
   pre-dump a diff into the prompt (that's the point of the chain — a real review, not a skim). All
   print text findings, so one classifier handles all. Binaries are invoked by **absolute path** (the
   review shell doesn't source `~/.zshrc`). **Assume cline (providers `openai-codex`, `zai-coding-plan`,
   `moonshot`) and claude are configured and logged in** — never prompt for or set keys/models during
   execution; the workflow only invokes the CLIs. Setup is in the README.

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
- The review subagent **runs ONE reviewer (fallback order gpt-5.5 → GLM-5.2 → Claude Sonnet → Kimi)
  and classifies**; it never edits. Fixes are a separate subagent.
- Verify, don't assume: if a gate (`lint`/`typecheck`/`test`) isn't green, the item isn't done.
- Surface blockers and merge/push decisions to the human; make only the small calls yourself.
