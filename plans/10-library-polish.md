# 10 — Library polish

## 1. Goal
Search bar (filters by title/author), sort by recent/A-Z/in-progress. Progress badges on downloaded books.

## 2. Acceptance
- Search input filters book grid in real-time.
- Sort dropdown: Recent, A–Z, Downloaded first.
- Downloaded books show green badge.
- Typecheck clean.

## 3. Files touched
```
artifacts/player/src/pages/Library.tsx   (add search + sort + badges)
PLAN.md
```

## 4. Risky seams
- Search must be client-side (filter cached books) — no extra API calls.
- Sort by "recent" uses purchaseDate field from book metadata.

## 5. Rollback
Revert commit.
