---
name: gated-plan-brainstorm
description: Run a multi-persona "meeting" that deliberates a subjective, open-ended topic into concrete decisions and directions, then writes a markdown brief that `gated-plan-create` can turn into a plan. Use when the work isn't a known checklist yet — the question is what to even build/do ("should we adopt X?", "how should this subsystem be shaped?", "which direction here?"). A chair (this skill) casts a roster of deliberately-clashing personas dynamically for the topic, each voiced by the Cursor agent CLI (headless `-p --trust`, read-only — auto-routed model that can read the repo to ground its view), and drives them through opening positions → debate rounds → convergence → a final objections pass. Triggers on "brainstorm directions", "run a brainstorm meeting", "let's decide the approach first", "/gated-plan-brainstorm <topic>". Pairs with `gated-plan-create`, which consumes the brief this skill writes.
---

# gated-plan-brainstorm

The front of the trio: **brainstorm → create → execute**. `create` splits *known* work into commits;
`execute` builds it. This skill decides **what the work even is** when the topic is subjective and
open-ended — by running a simulated design meeting: a roster of clashing personas, each voiced by the
Cursor agent, argued to a decision.

You are the **chair**. A roster of personas — cast dynamically to fit the topic, with deliberately
clashing stances, like inviting different experts to a meeting — debate the question. Personas can't
message each other directly (workflow agents are stateless), so the chair threads a shared
**transcript** into every persona each round: "talking to each other" happens through the transcript,
facilitator-mediated, exactly like a real meeting. The deterministic choreography lives in the bundled
workflow `brainstorm-meeting.js` (next to this file); this skill frames the topic, launches it, and
presents the brief.

Every persona is voiced by the **Cursor `agent` CLI** (auto-routed model, Cursor codebase index); the
chair (this session) sits above them. Diversity comes from the persona **briefs**, not from mixing
models. Personas run **read-only** (`-p --trust`, no `--force`) so they can ground themselves in the
repo but edit nothing.

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

   Each persona turn is delegated to the Cursor agent (read-only, auto-routed). Output defaults to
   final-answer-only text (no `--json`); the command redirects to a temp file and the subagent reads
   the `tail`. The binary is invoked by **absolute path** (`/Users/mradul/.local/bin/agent`; the shell
   doesn't source `~/.zshrc`); assume the Cursor agent is configured and logged in — never set
   keys/models here. If the agent can't run a turn (connection/quota/auth), that persona stays silent
   for the round rather than blocking the meeting.

3. **Present the result.** Show the user the returned `summary`, the `centralQuestion`, the roster,
   and the brief path. Read the brief and surface the key decisions, the live dissent, and the open
   questions plainly — don't oversell consensus the meeting didn't reach.

4. **Hand off.** Suggest the next step: `/gated-plan-create <briefPath>` — `create` reads the brief as
   its input and does the measured, ground-truth splitting into commits. Keep the separation: this
   skill decides directions; `create` owns the plan.

## Guardrails
- Fully autonomous between launch and brief — workflows can't pause mid-run for input. The human
  checkpoints are at the edges: framing the topic going in, reviewing the brief coming out.
- The chair never writes the personas' arguments — each turn is a **delegated read-only Cursor agent**;
  the chair only casts the roster, synthesizes, and drafts/finalizes the brief.
- Personas are **read-only** (`-p --trust`, no `--force`) — a brainstorm edits nothing.
- Output is a **markdown brief**, not a plan YAML — `gated-plan-create` still owns the splitting.
- Surface dissent honestly. A brief that hides the clashes is worse than no brief — `create` needs the
  real trade-offs to plan well.
