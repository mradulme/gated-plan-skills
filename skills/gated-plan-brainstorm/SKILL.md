---
name: gated-plan-brainstorm
description: Run a multi-persona "meeting" that deliberates a subjective, open-ended topic into concrete decisions and directions, then writes a markdown brief that `gated-plan-create` can turn into a plan. Use when the work isn't a known checklist yet — the question is what to even build/do ("should we adopt X?", "how should this subsystem be shaped?", "which direction here?"). A chair (this skill) casts a roster of deliberately-clashing personas dynamically for the topic, each voiced by a DIFFERENT pooled model CLI chosen by skills/_shared/pool.mjs (glm/minimax/kimi/codex/cursor — read-only, can read the repo to ground its view), so distinct model minds clash, and drives them through opening positions → debate rounds → convergence → a final objections pass. Triggers on "brainstorm directions", "run a brainstorm meeting", "let's decide the approach first", "/gated-plan-brainstorm <topic>". Pairs with `gated-plan-create`, which consumes the brief this skill writes.
---

# gated-plan-brainstorm

The front of the trio: **brainstorm → create → execute**. `create` splits *known* work into commits;
`execute` builds it. This skill decides **what the work even is** when the topic is subjective and
open-ended — by running a simulated design meeting: a roster of clashing personas, each voiced by a
different pooled model, argued to a decision.

You are the **chair**. A roster of personas — cast dynamically to fit the topic, with deliberately
clashing stances, like inviting different experts to a meeting — debate the question. Personas can't
message each other directly (workflow agents are stateless), so the chair threads a shared
**transcript** into every persona each round: "talking to each other" happens through the transcript,
facilitator-mediated, exactly like a real meeting. The deterministic choreography lives in the bundled
workflow `brainstorm-meeting.js` (next to this file); this skill frames the topic, launches it, and
presents the brief.

Each persona is voiced by a **different pooled model** — the chair assigns a distinct model per seat
(round-robin over `pool.mjs`'s ordered, warmup/value-aware id list), so diversity comes from **both**
the persona briefs **and** genuinely different model minds. The chair (this session) sits above them.
Personas run **read-only** so they can ground themselves in the repo but edit nothing; each turn is
scored to the shared scoreboard. Claude is not pooled.

## Inputs
- **Required:** the topic / question to brainstorm (the skill argument). If none given, ask for it.
- **Optional:** roster size cap (`maxPersonas`, default 5) and debate-round cap (`maxRounds`, default 3).

## Procedure

1. **Understand the topic.** If it's codebase-specific, skim the relevant files read-only so you can
   frame a sharp question — but don't pre-decide the answer; that's the meeting's job. If the topic is
   actually a known, concrete checklist (not subjective), say so and point the user at
   `gated-plan-create` directly — this skill is for genuinely open questions.

2. **Run the meeting** via the bundled workflow (this is the explicit opt-in to call `Workflow`).
   Pass `args` as an actual JSON object, not a string:

   ```
   Workflow({
     scriptPath: '<absolute path to brainstorm-meeting.js beside this SKILL.md>',
     args: {
       topic: '<the subjective question>',
       outDir: 'docs/brainstorms',   // where the brief lands
       maxPersonas: 5,               // roster cap (chair casts 3–maxPersonas)
       maxRounds: 3                  // debate rounds beyond the opening; stops early on convergence
     }
   })
   ```

   The workflow runs in the background and returns
   `{ briefPath, centralQuestion, personas, rounds, summary }`. Its phases (visible in `/workflows`):
   **Cast** (chair sharpens the question and casts the roster) → **Open** (each persona's opening
   position, in parallel; chair
   synthesizes) → **Debate** (facilitator-mediated rounds, each persona reads the full transcript +
   the chair's read of the room and responds; chair re-synthesizes and **stops early once converged**)
   → **Converge** (chair drafts the decision brief) → **Objections** (personas critique the draft in
   parallel; chair folds in legitimate objections and writes the final markdown).

   Each persona turn is delegated to that persona's **assigned pooled model**, run read-only via
   `pool.mjs cmd --id <model> --role brainstorm`. The command redirects to a temp file and the subagent
   reads the `tail`; pool.mjs emits absolute / config-dir invocations (the shell doesn't source
   `~/.zshrc`); assume the pooled CLIs are configured and logged in — never set keys/models here. If a
   persona's model can't run a turn (connection/quota/auth), that persona stays silent for the round
   (recorded as unavailable) rather than blocking the meeting.

3. **Present the result.** Show the user the returned `summary`, the `centralQuestion`, the roster,
   and the brief path. Read the brief and surface the key decisions, the live dissent, and the open
   questions plainly — don't oversell consensus the meeting didn't reach.

4. **Hand off.** Suggest the next step: `/gated-plan-create <briefPath>` — `create` reads the brief as
   its input and does the measured, ground-truth splitting into commits. Keep the separation: this
   skill decides directions; `create` owns the plan.

## Guardrails
- Fully autonomous between launch and brief — workflows can't pause mid-run for input. The human
  checkpoints are at the edges: framing the topic going in, reviewing the brief coming out.
- The chair never writes the personas' arguments — each turn is a **delegated read-only pooled model**;
  the chair only casts the roster, assigns models, synthesizes, and drafts/finalizes the brief.
- Personas are **read-only** — a brainstorm edits nothing.
- Output is a **markdown brief**, not a plan YAML — `gated-plan-create` still owns the splitting.
- Surface dissent honestly. A brief that hides the clashes is worse than no brief — `create` needs the
  real trade-offs to plan well.
