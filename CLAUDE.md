# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project objective

The real goal is a **cross-platform app (Capacitor-style, web + iOS + Android from one codebase) that plays Audible audiobooks at up to 16× speed**, bypassing Audible's native 3.5× cap. See `FEATURES.md` for the scoped feature list and `FRAMEWORK.md` for the framework decision and rationale.

The current `artifacts/libation` (React + Vite web) and `artifacts/audiobook-player` (Expo) apps are reference implementations from the original Replit download — **not the shipping target**. The Audible auth / download / DRM-removal code under `artifacts/api-server/src/lib/` is reusable logic. Streaming playback is explicitly rejected; books must be downloaded and played from local storage.

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

**Speed player** (`artifacts/player`) — Capacitor 7 + Vite + React; shipping shell for phone builds. API base URL is **`SPEED_API_ORIGIN`** in `artifacts/player/src/lib/platformConfig.ts` (default public URL; override at build time with **`VITE_SPEED_API_ORIGIN`**, e.g. for an SSH tunnel). All `fetch` paths use `${SPEED_API_ORIGIN}/api/...`. See `.env.tunnel.example` and `pnpm --filter @workspace/player run build:tunnel`.

## VPS deploy + iOS simulator (Speed)

Use this when running the Audible API on a droplet and testing the **player** on the iOS Simulator.

**API install on Ubuntu (e.g. DigitalOcean)**  
- From repo root: `sudo ./scripts/server-setup.sh --system` then `./scripts/server-setup.sh --app` (or a single `sudo ./scripts/server-setup.sh` as root). Installs Node 22, pnpm, ffmpeg, Python venv at `artifacts/api-server/.venv`, and builds `@workspace/api-server`.  
- Env: copy `scripts/speed-api.env.example` to e.g. `/etc/speed/api.env` (`PORT=3001`, etc.).  
- Systemd: `./scripts/server-setup.sh --print-systemd` → install unit with `EnvironmentFile=/etc/speed/api.env`, `WorkingDirectory` = `artifacts/api-server`, `ExecStart` = `node …/dist/index.mjs`, `PATH` prefixed with `artifacts/api-server/.venv/bin` so **`audible_auth.py`** runs with venv Python.  
- **Python bridge** (`artifacts/api-server/src/lib/pythonBridge.ts`): prefers `artifacts/api-server/.venv/bin/python3` when present so `spawn` does not pick system `python3` without `audible`/`httpx`.
- **Temp artifact policy**: downloaded/converted server files are temporary; phone confirms transfer via API and server sweeps expired done jobs. Tune with `SPEED_DOWNLOAD_DONE_TTL_MS` and `SPEED_DOWNLOAD_SWEEP_INTERVAL_MS`.
- **Diagnostics**: `GET /api/healthz/runtime` and `GET /api/audible/diagnostics` expose queue depth, temp bytes, and free disk for ops checks.
- **Current host hardening baseline**: service runs as non-root user **`fred`** (not `root`) with `UMask=0077`; sensitive files like `/etc/speed/api.env`, `.audible-session.json`, and `.pending-sessions.json` are owner-only/group-restricted.

**Default client URL: plain HTTP to Node**  
The player’s default **`SPEED_API_ORIGIN`** is **`http://[2400:6180:10:200::b9d7:6000]:3001`** (Express listens on `*:3001`). No reverse proxy required. Open **inbound TCP 3001** on the cloud firewall if clients cannot connect.

**Optional TLS (Caddy, nginx, etc.)**  
If **`http://<ip>:3001`** is blocked (unrated IP, closed port) or you want HTTPS, add a proxy on 80/443 yourself (e.g. Caddy + Let’s Encrypt for `https://api.example.com` → `127.0.0.1:3001`) and set **`VITE_SPEED_API_ORIGIN`** to that URL. **sslip.io**-style hostnames are often blocked as “Dynamic DNS” on school/enterprise filters.

**Locked-down networks**  
Use **SSH tunnel + `build:tunnel`**, **`VITE_SPEED_API_ORIGIN`** to your own domain, IT allow-list, or hotspot—see below.

**Updating the server over SSH**  
- SSH as `fred`: `ssh fred@[2400:6180:10:200::b9d7:6000]` (root login is no longer the default workflow).  
- If changes are on `origin`: `cd /home/fred/audible_speed && git pull && pnpm --filter @workspace/api-server run build && sudo systemctl restart speed-api`.  
- If only local commits exist: `scp` `artifacts/api-server/src/lib/pythonBridge.ts` and `artifacts/api-server/scripts/audible_auth.py` (and rebuild + restart), or commit and push then pull on the VPS.

**iOS Simulator (player)**  
- `pnpm --filter @workspace/player run build && pnpm --filter @workspace/player exec cap sync ios`  
- Non-interactive device: `xcrun simctl list devices available | grep iPhone` → `cd artifacts/player && pnpm exec cap run ios --target <UDID>`  
- `ios/App/App/Info.plist` already relaxes ATS for non-HTTPS / user API origins when needed.

**Local `speed-api` on your Mac (Simulator → `127.0.0.1:3001`)**  
When the droplet URL fails from the app but you want to test on the **iOS Simulator**, run the API locally and bake in **`http://127.0.0.1:3001`**:  
1. From repo root (with Python venv for `audible_auth.py`): `export PORT=3001` and `export PATH="$PWD/artifacts/api-server/.venv/bin:$PATH"`, then `pnpm --filter @workspace/api-server run dev` (or `run build` + `run start`).  
2. Confirm: `curl -sS http://127.0.0.1:3001/api/healthz` → `{"status":"ok"}`.  
3. `pnpm --filter @workspace/player run build:local && pnpm --filter @workspace/player exec cap sync ios` (same as `build:tunnel`; Simulator treats `127.0.0.1` as the **host Mac**).  

**SSH tunnel when web filters block the droplet (HTTP/HTTPS / Dynamic DNS)**  
If you can **`ssh fred@[2400:6180:10:200::b9d7:6000]`** but browsers/Simulator cannot reach the public API URL (unrated IP, blocked sslip.io, etc.), forward the API to your Mac and point the player at loopback:  
1. In a separate terminal: `ssh -N -L 3001:127.0.0.1:3001 fred@[2400:6180:10:200::b9d7:6000]` (forwards remote `speed-api` to Mac `127.0.0.1:3001`).  
2. Build the player with the tunnel URL baked in: `pnpm --filter @workspace/player run build:tunnel && pnpm --filter @workspace/player exec cap sync ios` (or `dev:tunnel` for Vite only).  
3. The iOS Simulator uses **`127.0.0.1`** as the **host Mac** for loopback; a physical iPhone on Wi‑Fi does **not** see that tunnel unless you use something like Tailscale or a proxy on the LAN.  
Agents/automation can still deploy over SSH as `fred` (`git pull`, `pnpm --filter @workspace/api-server run build`, `sudo systemctl restart speed-api`); the tunnel is a **client-side** workaround for locked-down networks.

## Ports (Replit)

`api-server` uses `PORT`; externally-visible ports from `.replit`: 8080, 8081 (→80), 19791 (→3000), 19984 (→3002, libation), 19985 (→3003). Don't hard-code ports — read `PORT`.
