# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace

pnpm workspace monorepo on Node 24 / TypeScript 5.9. Packages live in `artifacts/*` (deployable apps) and `lib/*` (shared libraries) and resolve each other via `workspace:*`. The root `tsconfig.json` composite-builds the `lib/*` projects only; artifacts typecheck independently. Imports use the `workspace` custom TS condition (see `tsconfig.base.json`) so consumers resolve source files directly from sibling packages without a build step.

## Commands

- `pnpm run typecheck` — typecheck everything (`tsc --build` for libs, then per-artifact `typecheck`)
- `pnpm run build` — typecheck + run every package's `build` script
- `pnpm --filter @workspace/api-server run dev` — build and start the Express API (requires `PORT`)
- `pnpm --filter @workspace/libation run dev` — Vite dev server (requires `PORT` and `BASE_PATH`)
- `pnpm --filter @workspace/audiobook-player run dev` — Expo dev server (requires `PORT`, plus Replit env vars)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate `lib/api-client-react` and `lib/api-zod` from `lib/api-spec/openapi.yaml` (runs typecheck after)
- `pnpm --filter @workspace/db run push` — push Drizzle schema to the DB (`DATABASE_URL` required); `push-force` variant for destructive changes. `scripts/post-merge.sh` runs this automatically after `git merge`.

Single-package typecheck: `pnpm --filter <name> run typecheck`. There is no test runner configured.

## Supply-chain safety

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (24h). Do not disable it. New non-`@replit` packages must wait 24h from publish or be added to `minimumReleaseAgeExclude` only for trusted publishers and removed once the window elapses.

The workspace is Replit-hosted (linux-x64 only); `overrides` in `pnpm-workspace.yaml` blacklists all other-platform optional native binaries for esbuild/rollup/lightningcss/etc. When adding a native-dep package, expect to extend those overrides rather than pulling in every platform variant.

## Architecture

**API contract is OpenAPI-first.** `lib/api-spec/openapi.yaml` is the source of truth. Orval generates:
- `lib/api-client-react/src/generated/` — React Query hooks + TS types, consumed by `libation` and `audiobook-player`. `custom-fetch.ts` provides `setBaseUrl`/`setAuthTokenGetter` for runtime config.
- `lib/api-zod/src/generated/` — Zod validators + TS types, consumed by `api-server` for request validation.

When changing the API, edit `openapi.yaml` then run codegen. Do not hand-edit files under `generated/`.

**API server** (`artifacts/api-server`) is Express 5 + pino, bundled to a single ESM file via `esbuild` (`build.mjs`). The build externalizes native modules and uses `esbuild-plugin-pino` to keep pino's worker transports functional post-bundle. `src/app.ts` mounts everything under `/api`; routes live in `src/routes/`. Reads `PORT` from env and fails fast if missing/invalid.

**Audible/Libation backend** (`artifacts/api-server/src/routes/audible.ts` + `src/lib/audible*.ts`, `downloadManager.ts`) implements PKCE OAuth with Amazon, in-memory session storage, Audible library fetching, and an async download queue that uses `ffmpeg -activation_bytes <hex>` to strip DRM from `.aax` files into MP3/M4B. Activation bytes are set per-session via `POST /api/audible/settings/activation-bytes`. Downloaded files land in `artifacts/api-server/downloads/`.

**Libation frontend** (`artifacts/libation`) — React 19 + Vite + Tailwind v4 + Radix + wouter + React Query. Uses `@workspace/api-client-react` hooks. Requires `PORT` and `BASE_PATH` env vars (app is served under a sub-path on Replit). Pages: `auth`, `library`, `downloads`.

**Audiobook player** (`artifacts/audiobook-player`) — Expo Router (React Native) app, shares the same API client. `dev` script wires Expo to Replit proxy domains.

**Database** (`lib/db`) — Drizzle ORM + `pg` Pool, export is `db` and `pool` from `src/index.ts`. Schemas live in `src/schema/*.ts` and must be re-exported from `src/schema/index.ts` (template is in place but empty). Requires `DATABASE_URL`.

**Mockup sandbox** (`artifacts/mockup-sandbox`) — standalone Vite + Tailwind playground for UI mockups; not wired to the API.

## Ports (Replit)

`api-server` uses `PORT`; externally-visible ports from `.replit`: 8080, 8081 (→80), 19791 (→3000), 19984 (→3002, libation), 19985 (→3003). Don't hard-code ports — read `PORT`.
