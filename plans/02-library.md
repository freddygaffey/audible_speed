# 02 — Library list

## 1. Goal
Show the user's Audible library as a scrollable book grid. Data cached to localStorage; offline shows cached books with a banner.

## 2. Acceptance
- `/library` route renders a grid of book covers + titles.
- Network tab shows `GET /api/audible/library`.
- On reload with API server down, cached books still show.
- Typecheck clean.

## 3. Files touched
```
artifacts/player/package.json              (add @tanstack/react-query)
artifacts/player/src/main.tsx              (wrap with QueryClientProvider)
artifacts/player/src/lib/apiClient.ts      (add fetchLibrary)
artifacts/player/src/lib/libraryCache.ts   (new — localStorage cache)
artifacts/player/src/pages/Library.tsx     (new — book grid)
artifacts/player/src/App.tsx               (add /library route, redirect home → /library)
PLAN.md
```

## 4. Risky seams
- localStorage size: 100 books ≈ 50 KB, fine; 1000 books ≈ 500 KB, still fine for localStorage.
- Cover images can 404 — handle with onError fallback.
- API server returns `status` field alongside each book; schema must include it.

## 5. Rollback
Revert commit.
