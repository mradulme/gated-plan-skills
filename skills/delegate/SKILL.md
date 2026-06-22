---
name: delegate
description: Hand an isolated, well-scoped piece of work to another coding agent (GLM, MiniMax, Kimi, GPT 5.5/codex, the Cursor agent, or a native Claude subagent) when it improves cost, speed, or quality — read-only for investigation/review/critique/debugging, write only for clearly-scoped implementation. Use for one-off second opinions, analysis, drafts, refactors, tests, and reviews outside the gated-plan loop. The exact invocations come from the shared pool (skills/_shared/pool.mjs), and every run is recorded to the central scoreboard. Triggers on "delegate this", "get a second opinion", "have another model look at this", "/delegate <task>".
---

# delegate

Offload an isolated unit of work to another coding agent when doing so improves **cost, speed, or
quality**. This is the ad-hoc cousin of `gated-plan-execute`: same pool of model CLIs, same scoreboard,
but driven by you on demand instead of from a plan YAML. You stay responsible for correctness,
integration, tests, and the final decision — delegate output is **advisory**.

## Who you can delegate to

- **External pooled CLIs** — `cursor` (Cursor agent, auto-routed), `glm` (GLM 5.2), `kimi` (Kimi 2.7),
  `minimax` (MiniMax M3), `codex` (GPT 5.5). Reach for these **first** for isolated analysis,
  implementation drafts, refactors, tests, reviews, or second opinions.
- **Native Claude Code subagents** (the `Agent` tool) — use **only** when the task needs deep repo
  context, higher coordination quality, or Claude-specific tooling that an external CLI can't match.

Never hardcode the CLI commands here — the exact, environment-correct invocations (absolute paths,
config dirs, read vs write flags) live in **`skills/_shared/pool.mjs`**, the single source of truth.
You ask it for the command, run it, then record the outcome so the scoreboard stays accurate.

## Delegation rules

1. **Read-only by default.** Investigation, planning, code review, architecture critique, and
   debugging go through a read-only role — the delegate reasons over the repo and edits nothing.
2. **Write only when the task is a clearly-scoped implementation.** A concrete diff with named files
   and a definition of done — not "figure out what to do".
3. **Never let two write-capable agents touch the same files in parallel.** Serialize writers, or give
   them disjoint file sets.
4. **Inspect the diff after any write** (`git diff`) before continuing. Treat it as a draft to verify,
   not a result to trust.
5. **Delegate output is advisory.** You own correctness, integration, tests, and the final call.
6. **Keep prompts narrow and concrete** — relevant file paths, the exact task, constraints, and the
   expected output shape. A vague prompt wastes the round-trip.
7. **Match the agent to the task.** Cheaper delegates for routine work; stronger agents (or let the
   router pick by value) for ambiguous, architectural, or high-risk work.

## Procedure

1. **Decide it's worth delegating.** Is the work isolated enough to hand off, and does an external
   model improve cost/speed/quality versus doing it inline? If it needs deep repo context or tight
   coordination, prefer a native Claude subagent (`Agent` tool) instead and skip the pool.

2. **Pick the role** (this sets read-vs-write and which scoreboard bucket the run lands in):
   - `advisory` — read-only investigation, planning, architecture critique, debugging (advise bucket).
   - `review` — read-only code review of a diff/branch (review bucket).
   - `implement` / `fix` — write-capable, clearly-scoped implementation or fix (code bucket).

3. **Write a tight prompt to a temp file.** Include the exact task, file paths, constraints, and the
   expected output. For read-only roles, tell it to reason and report (no edits). For write roles, name
   the files in scope and the done condition.
   ```
   F=.gated-plan-tmp/delegate-prompt.txt   # write your prompt here (Write tool or heredoc)
   OUT=.gated-plan-tmp/delegate-out.txt
   ```
   For a **write** role (it may `git add` + commit), first keep this scratch dir out of staging —
   idempotent, writes the local `.git/info/exclude`, not the tracked `.gitignore`:
   ```
   grep -qxF '.gated-plan-tmp/' "$(git rev-parse --git-dir)/info/exclude" 2>/dev/null \
     || echo '.gated-plan-tmp/' >> "$(git rev-parse --git-dir)/info/exclude"
   ```

4. **Get the command from the pool** (absolute path — the shell does NOT source `~/.zshrc`):
   - **Specific delegate** the user named or you chose — pin it:
     ```
     node /Users/mradul/git/gated-plan-skills/skills/_shared/pool.mjs cmd \
       --id <cursor|glm|kimi|minimax|codex> --role <advisory|review|implement> --file "$F" --out "$OUT"
     ```
     → prints `{ id, command }`.
   - **Let the router pick by value** (fair-warmup then best value-for-money) when you don't care which:
     ```
     node /Users/mradul/git/gated-plan-skills/skills/_shared/pool.mjs route \
       --role <advisory|review|implement> --file "$F" --out "$OUT" [--exclude id,id]
     ```
     → prints `{ chosen: { id, command }, fallbackIds: [...] }`.

5. **Run `command`.** It feeds your prompt via `"$(cat "$F")"`, writes to `$OUT`, and tails it. Read the
   tail for the delegate's answer. If it's unavailable (connection/quota/auth), re-route with
   `--exclude <id-that-failed>` (or `cmd --id <next>`) and run the new command — and record the failed
   attempt as unavailable (step 7).

6. **For write roles: inspect the diff** (`git diff`) before you build on it. Verify it compiles/lints/
   tests, fix or discard as needed. Do not fan a write task out to multiple models over the same files.

7. **Record the run to the scoreboard** so routing stays honest (absolute path):
   ```
   node /Users/mradul/git/gated-plan-skills/skills/_shared/pool.mjs record \
     --role <role> --model <id-that-ran> --available <true|false>
   ```
   For a **write** run, add what you observed: `--committed <true|false>` (did it produce a usable
   diff), `--gate-first-try <true|false>`, `--stuck <true|false>`. Record **every** attempt — including
   ones that came back unavailable (`--available false`) — so the bandit learns. Don't record native
   Claude subagent runs (Claude is intentionally not in the pool).

## Guardrails

- One source of truth: invocations come from `pool.mjs`, never inline literals. The pool is
  preconfigured — never set API keys or model names yourself.
- Read-only unless the task is a scoped implementation. When in doubt, delegate read-only and apply the
  changes yourself.
- Serialize writers; inspect every delegated diff; the final decision and integration are yours.
- This skill is for **isolated, ad-hoc** delegation. For a whole checklist of commits gated by review,
  use `gated-plan-execute` instead — it already routes and scores every item through the same pool.
