# 00 — Scaffold `artifacts/player`

## 1. Goal
Create `artifacts/player` as a pnpm workspace member: Vite + React 19 + TypeScript + Tailwind v4 + Capacitor core, one root route renders in a browser, typecheck and dev server green.

## 2. Acceptance
- `pnpm --filter @workspace/player run typecheck` exits 0
- `PORT=3010 pnpm --filter @workspace/player run dev` serves a page at localhost:3010
- `pnpm run typecheck` (root) exits 0 — existing packages unaffected

## 3. Files touched
```
plans/00-scaffold.md
artifacts/player/package.json
artifacts/player/tsconfig.json
artifacts/player/vite.config.ts
artifacts/player/capacitor.config.ts
artifacts/player/index.html
artifacts/player/src/main.tsx
artifacts/player/src/App.tsx
artifacts/player/src/pages/Home.tsx
artifacts/player/src/index.css
```

## 4. Risky seams
- Platform overrides block darwin-arm64 esbuild/rollup: esbuild self-heals via npm fallback, confirmed working.
- Tailwind v4 import syntax: `@import "tailwindcss"` not `@tailwind base`.
- Capacitor config must typecheck cleanly with `@capacitor/core` installed.

## 5. Rollback
`git rm -r artifacts/player plans/00-scaffold.md` and revert PLAN.md.
