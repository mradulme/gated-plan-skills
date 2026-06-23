---
name: gated-plan-research
description: Run a simulated-user research panel on an EXISTING product — features, design, aesthetics, snappiness — and synthesize a prioritized cut / keep / improve report that `gated-plan-create` can turn into a plan. Use when you want qualitative user feedback on what to trim, keep, or fix before planning the work (the counterpart to `gated-plan-brainstorm`, which decides what to build). A lead researcher (this skill) recruits a panel of user personas — each with a persona, Jobs-To-Be-Done, and pain points, and each voiced by a DIFFERENT pooled model CLI chosen by skills/_shared/pool.mjs (glm/minimax/kimi/codex/cursor — read-only, grounds itself in the repo) — who INDEPENDENTLY walk the product through their JTBD, then clusters findings by prevalence × severity. Triggers on "run user research", "simulate users on this", "what should we cut/keep/improve", "qualitative research run", "/gated-plan-research <surface>". Pairs with `gated-plan-create`, which consumes the report this skill writes.
---

# gated-plan-research

The **evaluate-what-exists** counterpart to `gated-plan-brainstorm`. Brainstorm decides *what to build*;
this skill gathers *qualitative user feedback on what you already built* — and turns it into a prioritized
**cut / keep / improve** report. It runs a simulated user-research study: a panel of user personas, each
voiced by a different pooled model, each walking the current product through their own Jobs-To-Be-Done.

You are the **lead researcher**. You recruit the panel and frame the task scenarios; the personas do the
evaluating. Unlike a brainstorm (where personas *argue toward consensus*), research users evaluate
**independently and in parallel** — no user sees another's notes, so no model anchors another and you get
genuinely independent data points. The researcher then **clusters findings by prevalence** (how many users
independently hit the same thing = priority) × severity. The deterministic choreography lives in the
bundled workflow `research-panel.js` (next to this file); this skill frames the study, launches it, and
presents the report.

Each persona is voiced by a **different pooled model** — round-robin over `pool.mjs`'s ordered,
warmup/value-aware id list — so diversity comes from **both** the persona briefs **and** genuinely
different model minds. Personas run **read-only**, grounding themselves in the repo (and any artifacts you
supply); each turn is scored to the shared scoreboard under the `research` role. Claude is not pooled.

> **What this is — and isn't.** The pooled models inspect **source read-only and cannot run the app.** So
> "snappiness" and visual "aesthetics" are **inferred from the implementation** (heuristic / expert-review
> style), not measured. This generates **hypotheses**, not empirical usability data. Every inferred finding
> is flagged, and the report ends with a **"Validate with real users"** section. Supply artifacts (below)
> to turn inference into grounded observation.

## Inputs
- **Required:** the **surface** to study — what product/area the users evaluate (the skill argument), e.g.
  "the onboarding flow", "the whole app". If none given, ask for it.
- **Optional:**
  - `focus` — narrow to areas, e.g. `["onboarding", "settings"]` (default: the whole surface).
  - `artifacts` — extra grounding beyond the repo so design/perf aren't pure inference. A list of
    `{ kind: 'url'|'screenshot'|'feature-list'|'perf-notes'|'doc', ref, note }`, where `ref` is a path /
    URL / inline text the personas may read & cite. Real screenshots or perf numbers flip findings from
    *inferred* to *grounded*.
  - `maxPanel` — panel size cap (default 5; researcher recruits 3–maxPanel).
  - `rounds` — `1` (default) = a single independent walkthrough; `2` = one extra focused re-look at the
    most contested/under-explored areas before prioritizing (still independent, not a debate).

## Procedure

1. **Understand the surface.** Skim the relevant files read-only so you can frame sharp, real task
   scenarios — but don't pre-judge the verdict; that's the panel's job. If the user actually wants to
   decide *what to build* (an open, subjective direction), point them at `gated-plan-brainstorm` instead —
   this skill evaluates what already exists.

2. **Run the study** via the bundled workflow (this is the explicit opt-in to call `Workflow`). Pass
   `args` as an actual JSON object, not a string:

   ```
   Workflow({
     scriptPath: '<absolute path to research-panel.js beside this SKILL.md>',
     args: {
       surface: '<what to study, e.g. "the onboarding flow">',
       focus: [],                    // optional area filter; [] = whole surface
       artifacts: [],                // optional: [{ kind, ref, note }] grounding for design/perf
       outDir: 'docs/research',      // where the report lands
       maxPanel: 5,                  // panel cap (researcher recruits 3–maxPanel)
       rounds: 1                     // 1 = single walkthrough; 2 = + one focused re-look
     }
   })
   ```

   The workflow runs in the background and returns
   `{ reportPath, surface, researchGoal, panel, themes, summary }`. Its phases (visible in `/workflows`):
   **Recruit** (researcher frames the goal + 3–6 task scenarios and recruits the panel; assigns a distinct
   model per persona) → **Walkthrough** (each user independently walks the product through their JTBD, in
   parallel) → **Affinity** (researcher clusters observations across users into themes with prevalence +
   severity) → **Prioritize** (themes ranked into cut / keep / improve by prevalence × severity, each with
   a confidence) → **Report** (users member-check the draft in parallel; researcher folds in corrections
   and writes the final markdown).

   Each session is delegated to that persona's **assigned pooled model**, run read-only via
   `pool.mjs cmd --id <model> --role research`. The command redirects to a temp file and the subagent
   reads the `tail`; pool.mjs emits absolute / config-dir invocations (the shell doesn't source
   `~/.zshrc`); assume the pooled CLIs are configured and logged in — never set keys/models here. If a
   user's model can't run a turn (connection/quota/auth), that user is absent for the round (recorded as
   unavailable) rather than blocking the study.

3. **Present the result.** Show the user the returned `summary`, the `researchGoal`, the panel (with the
   model behind each persona), and the report path. Read the report and surface the headline
   cut/keep/improve calls, the **confidence** on each, and the divergences plainly — don't oversell:
   inferred snappiness/aesthetic findings are hypotheses, not measurements.

4. **Hand off.** Suggest the next step: `/gated-plan-create <reportPath>` — `create` reads the report as
   its input and does the measured splitting into commits. Treat **low-confidence** and **inferred** items
   as candidates for `excluded` or a validation phase rather than committing scope on them.

## Guardrails
- Fully autonomous between launch and report — workflows can't pause mid-run for input. The human
  checkpoints are at the edges: framing the surface (and supplying artifacts) going in, reviewing the
  report — and validating high-impact findings with real users — coming out.
- The researcher never writes the users' reactions — each session is a **delegated read-only pooled
  model**; the researcher only frames the study, assigns models, clusters, prioritizes, and writes the report.
- Users are **read-only and cannot run the app.** Snappiness and aesthetics are **inferred hypotheses**,
  always flagged as such, never presented as measured fact.
- **No invented features.** Users react only to capabilities that actually exist in the repo/artifacts;
  unmet needs are logged as wishlist gaps. Any theme depending on a non-existent feature is dropped.
- **Prevalence over anecdote.** Priority comes from how many users independently hit a thing, not how
  loudly one did — which is why users evaluate independently. Single-user or fully-inferred findings stay
  low-confidence. Personas are candid (some skeptical/impatient by design) — no flattery.
- Output is a **markdown report**, not a plan YAML — `gated-plan-create` still owns the splitting.
