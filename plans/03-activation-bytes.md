# 03 — Activation bytes

## 1. Goal
User can enter their 8-hex-char activation bytes. Stored encrypted in localStorage. Sent to API server before download starts. Without this, ffmpeg DRM strip fails.

## 2. Acceptance
- Settings page reachable from library header.
- Entering activation bytes calls `POST /api/audible/settings/activation-bytes`.
- Bytes persisted in localStorage, re-sent to API on app startup.
- Input validated: must be exactly 8 hex chars.
- Typecheck clean.

## 3. Files touched
```
artifacts/player/src/lib/activationBytes.ts  (new — store/load from localStorage)
artifacts/player/src/pages/Settings.tsx      (new — settings form)
artifacts/player/src/lib/apiClient.ts        (add setActivationBytes)
artifacts/player/src/App.tsx                 (add /settings route)
artifacts/player/src/pages/Library.tsx       (add settings icon link in header)
PLAN.md
```

## 4. Risky seams
- Activation bytes format: 8 hex chars (4 bytes). Validate with regex /^[0-9a-fA-F]{8}$/.
- API server stores activation bytes in-memory — re-send on startup from localStorage.
- No encryption for v1 — plain localStorage. Fine for personal-use app.

## 5. Rollback
Revert commit.
