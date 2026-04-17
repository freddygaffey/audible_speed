# 01 — Audible auth (web)

## 1. Goal
Player app can authenticate against Audible via the Express API server proxy: marketplace picker → email/password → optional OTP → session stored, persists across reloads.

## 2. Acceptance
- `PORT=3010 VITE_API_URL=http://localhost:3001 pnpm --filter @workspace/player run dev` starts.
- Auth page renders with 9 marketplace options.
- Entering email + password calls `POST /api/audible/auth/login` (visible in browser devtools).
- On success, app shows username and "Logged in" state.
- Reload → app restores auth state from localStorage + server status check.
- `pnpm --filter @workspace/player run typecheck` exits 0.

## 3. Files touched
```
artifacts/player/vite.config.ts          (add API proxy)
artifacts/player/package.json            (add lucide-react)
artifacts/player/src/lib/apiClient.ts    (new — typed fetch + Zod)
artifacts/player/src/lib/authContext.tsx (new — React context + localStorage)
artifacts/player/src/pages/Auth.tsx      (new — marketplace/credentials/OTP UI)
artifacts/player/src/pages/Home.tsx      (update — show user info when logged in)
artifacts/player/src/App.tsx             (update — auth-gated routing)
```

## 4. Risky seams
- CORS: player (port 3010) calls API (port 3001) — Vite proxy handles this in dev; need VITE_API_URL env for build time.
- API server uses in-memory sessions: restart = lost session. Acceptable for v1.
- maplanding redirect: not needed here since we use server-side form submission.

## 5. Rollback
`git revert HEAD` on this step's commit.
