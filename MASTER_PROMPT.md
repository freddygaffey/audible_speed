# Master Prompt

Paste this as the first message of a fresh Claude Code session in `/Users/fred/speed`. It bootstraps context and drives the build through `PLAN.md` one step at a time, with user check-in between steps.

**Do not** treat this as "build the whole app in one go". That path ships broken code. This prompt is an orchestrator, not a one-shot.

---

## Prompt — copy everything below

You are working in `/Users/fred/speed`. Before doing anything, read these files in order and treat them as ground truth:

1. `CLAUDE.md` — repo guide and project objective.
2. `FEATURES.md` — what the app must do.
3. `FRAMEWORK.md` — stack decision and why.
4. `PLAN.md` — master build order, step list, and per-step plan template.

The real goal: a cross-platform app (Capacitor + React + Vite + TS + Tailwind) that plays Audible audiobooks at up to 16× speed, bypassing Audible's native 3.5× cap. Web-first feedback loop. Books downloaded and decrypted on-device. Existing code under `artifacts/libation`, `artifacts/audiobook-player`, and `artifacts/api-server/src/lib/` is reference only — do not modify it unless I say so.

Your job is to drive `PLAN.md` step by step. For each step:

1. **Find the next step in `PLAN.md` that is `[ ]` (not started).** Stop if none.
2. **Write the per-step plan file** at `plans/NN-<name>.md` using the template at the bottom of `PLAN.md`. Be concrete: list files to touch, acceptance checks the user will run, risky seams where AI typically breaks.
3. **Show me the plan file and wait for my approval.** Do not write code yet. I may ask for edits.
4. **On approval, implement the step.** Small commits. Reuse existing Audible logic in `artifacts/api-server/src/lib/audibleAuth.ts`, `audibleClient.ts`, `downloadManager.ts` as the source of truth for Audible endpoints and flows — Audible's API is undocumented; do not invent endpoints.
5. **Run the acceptance checks.** Typecheck green, dev server up, the specific observable behaviour from the plan works. Report exactly what you ran and what you saw.
6. **Stop and tell me the checks passed.** Do not move to the next step. Wait for me to say "next" or similar. I will verify manually, then unblock.
7. **On my OK**, mark the step `[x]` in `PLAN.md`, commit, and go to step 1 for the next `[ ]` entry.

Rules that override anything else:

- **One step per approval.** Never batch. Never skip ahead. If a step reveals new work, add a new `[ ]` entry to `PLAN.md` rather than expanding the current step.
- **Zod at boundaries.** Every network response, every file read parsed, every Capacitor plugin return value validated with Zod. Reuse `lib/api-zod` where it already covers the shape.
- **Commit after every working sub-task**, not just at end of step. Small commits = cheap rollback.
- **No streaming playback.** Files must be downloaded and decrypted on-device.
- **Cross-platform first.** Every new module must run in a browser. Native-only code lives behind a platform shim with a web fallback.
- **Ask before destructive ops.** `git reset --hard`, force push, deleting files outside the step's scope, dropping dependencies, modifying `pnpm-workspace.yaml` overrides — stop and ask.
- **If stuck, stop and ask.** Do not guess Audible endpoints, activation-bytes retrieval, ffmpeg flags for `.aaxc`, or 16× pitch algorithms. Reference the existing code or ask me.
- **Caveman mode stays on** for chat. Code and commit messages stay normal.

Start now: read the four context files, then propose the plan for step 00 (`plans/00-scaffold.md`). Do not write any code yet.
