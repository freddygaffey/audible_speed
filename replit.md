# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### Audiobook Player (artifacts/audiobook-player)
- **Type**: Expo (React Native) mobile app
- **Preview path**: `/`
- **Features**:
  - Library screen with search, sort (Recent, In Progress, A-Z), and section grouping
  - Book cards with color-coded covers, progress badges, and chapter info
  - Player screen with play/pause, skip ±15s/30s, speed control (0.5x–3x), progress bar
  - Mini player that appears at bottom while listening
  - Add book modal for manually adding audiobooks with title, author, narrator, duration
  - Long-press to remove books from library
  - Persistence via AsyncStorage
  - Dark/light theme support via useColors hook

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
