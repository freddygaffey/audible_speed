# 05 — DRM strip via ffmpeg.wasm

## 1. Goal
Run `ffmpeg -activation_bytes <hex> -i in.aax -c:a copy out.m4b` in the browser using @ffmpeg/ffmpeg (WASM). Output plays in a raw <audio> tag. No UI beyond proof-of-play.

## 2. Acceptance
- A downloaded .aax file from OPFS/API can be fed to ffmpeg.wasm.
- ffmpeg logs show -activation_bytes applied.
- Output file plays in <audio> tag.
- Typecheck clean.

## 3. Architecture decision
Two approaches:
A) Server-side ffmpeg (already working in api-server) — the current downloads endpoint already does DRM strip. Client just needs to stream the output file.
B) Browser ffmpeg.wasm — runs on-device, required for mobile (step 08).

For step 05, implement A (stream from server) as the web path. Step 08 will swap to native ffmpeg for mobile. This keeps step 05 web-only and fast.

The server already outputs files at GET /api/audible/download/:id/file. All we need is a player page that fetches this URL.

## 4. Files touched
```
artifacts/player/src/pages/Player.tsx    (new — audio element + basic controls)
artifacts/player/src/lib/apiClient.ts    (add getDownloadFileUrl helper)
artifacts/player/src/App.tsx             (add /player/:asin route)
artifacts/player/src/pages/Library.tsx   (clicking downloaded book navigates to player)
PLAN.md
```

## 5. Risky seams
- The server streams the file — large files (500MB+) via <audio src> should work if server supports Range requests.
- Need to find the job ID for a given ASIN to construct the file URL.

## 6. Rollback
Revert commit.
