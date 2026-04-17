# 06 — Player UI

## 1. Goal
Full player with play/pause, seek, skip ±30s, book cover, title/author. Works against local decrypted file. Still web-only.

## 2. Acceptance
- Player page shows cover, title, author.
- Progress bar is draggable and updates in real-time.
- Skip ±30s buttons work.
- Chapter list if available (from book metadata).
- Typecheck clean.

## 3. Files touched
```
artifacts/player/src/pages/Player.tsx    (expand with cover, metadata, chapter UI)
artifacts/player/src/lib/libraryCache.ts (add getBook by asin helper)
PLAN.md
```

## 4. Risky seams
- Seeking requires server Range request support. Workaround: preload="auto" for full buffer.
- Cover URL from book metadata in library cache.

## 5. Rollback
Revert commit.
