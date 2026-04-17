# 04 — Download one book

## 1. Goal
Each book card has a Download button that triggers the server-side download (fetch .aax → ffmpeg DRM strip). Progress shows on card. Done state persists.

## 2. Acceptance
- Download button on book cards.
- Clicking calls `POST /api/audible/download`.
- Progress bar updates via polling `GET /api/audible/downloads`.
- When status=done, card shows checkmark.
- Downloads list survives library re-render.
- Typecheck clean.

## 3. Files touched
```
artifacts/player/src/lib/apiClient.ts        (add download API calls)
artifacts/player/src/hooks/useDownloads.ts   (new — polling hook)
artifacts/player/src/pages/Library.tsx       (download button on BookCard)
PLAN.md
```

## 4. Risky seams
- Poll interval: 2s when active downloads exist, none when all done.
- Book status comes from library endpoint (cross-references jobs server-side).
- Progress % comes from download job, not library.

## 5. Rollback
Revert commit.
