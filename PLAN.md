# Master Plan

High-level build order for the 16×-Audible cross-platform app. Each step gets its own detailed plan file (`plans/NN-<name>.md`) written before that step starts. Do not skip ahead — web-first feedback loop is the whole point.

Related docs: `FEATURES.md` (what), `FRAMEWORK.md` (how), `CLAUDE.md` (repo guide).

## Principles

- Web-first. Every step works in a browser before touching iOS/Android.
- One feature per step. Ship, commit, next.
- Reuse existing Audible logic in `artifacts/api-server/src/lib/` as reference — don't let AI re-invent undocumented endpoints.
- Zod at every boundary. Catch hallucinations at runtime.
- Commit after every working step. Cheap rollback.

## Status legend

- [ ] not started
- [~] in progress
- [x] done
- [!] blocked / decision needed

## Steps

### [x] 00 — Scaffold `artifacts/player`
Vite + React + TS + Tailwind + Capacitor shell. pnpm workspace member. One empty route renders. Typecheck + dev server green.
Detailed plan: `plans/00-scaffold.md`

### [x] 01 — Audible auth (web)
PKCE flow end-to-end in the browser. Port logic from `audibleAuth.ts`. Marketplace picker, popup, paste redirect URL, extract code, exchange for tokens. Session persists across reloads. All 9 marketplaces selectable.
Detailed plan: `plans/01-auth.md`

### [x] 02 — Library list
`GET /api/audible/library` (or direct Audible call — decide in plan). Render book grid. Cache to IndexedDB. Offline read works after first load.
Detailed plan: `plans/02-library.md`

### [x] 03 — Activation bytes
Capture / retrieve activation bytes. Store encrypted locally. Without this, DRM strip fails.
Detailed plan: `plans/03-activation-bytes.md`

### [x] 04 — Download one book
Fetch `.aax` / `.aaxc` to local storage (OPFS on web). Progress bar. Resume on failure. Verify file on disk before marking done.
Detailed plan: `plans/04-download.md`

### [x] 05 — DRM strip via ffmpeg.wasm
Run `ffmpeg -activation_bytes <hex> -i in.aax -c:a copy out.m4b` in the browser. Output plays in a raw `<audio>` tag. No UI yet.
Detailed plan: `plans/05-drm-strip.md`

### [x] 06 — Player UI
Play/pause, seek, chapters, skip ±30s. Works against a local decrypted file. Still web-only.
Detailed plan: `plans/06-player-ui.md`

### [x] 07 — Pitch-preserving speed 0.5×–16×
`soundtouch-js` or `rubberband-wasm` in an AudioWorklet. 17-step slider. Judge intelligibility at 16× by ear. Pick the algorithm that actually works at high speed, not the first one that compiles.
Detailed plan: `plans/07-speed.md`

### [x] 08 — Capacitor iOS + Android wrap
Add native shells. Swap web shims: storage → Filesystem plugin, ffmpeg.wasm → native ffmpeg plugin. One build per platform runs a previously-downloaded book end-to-end.
Detailed plan: `plans/08-capacitor-wrap.md`

### [x] 09 — Background playback
Lock-screen controls, continue playing when screen off, resume on app foreground. iOS + Android specifics diverge here.
Detailed plan: `plans/09-background-playback.md`

### [x] 10 — Library polish
Search, sort (recent / in-progress / A–Z), progress badges. Port UX patterns from `artifacts/audiobook-player` and `artifacts/libation`.
Detailed plan: `plans/10-library-polish.md`

## Nice-to-have (after must-haves ship)

### [ ] 11 — Web deploy
Static build + deploy. Same codebase, browser target. Feature-flag the native-only bits.
Detailed plan: `plans/11-web-deploy.md`

### [ ] 12 — Audible progress sync
Push listening position back to Audible so other clients see it.
Detailed plan: `plans/12-progress-sync.md`

## Out of scope (do not build)

- Sharing / exporting decrypted files.
- Multi-account switching.
- Streaming playback — books must be on-device.
- Server-side library management beyond what the on-device app needs.

## Per-step plan template

When starting step NN, create `plans/NN-<name>.md` with:

1. **Goal** — one sentence. What "done" looks like.
2. **Acceptance** — bullet list of observable checks. User runs these, not AI.
3. **Files touched** — paths to create/edit. Narrow scope = fewer AI hallucinations.
4. **Risky seams** — where AI usually ships broken. Flag for manual test.
5. **Prompts** — the actual prompts to feed Claude, in order. Short, concrete, one feature each.
6. **Rollback** — commit hash to revert to if the step goes sideways.
