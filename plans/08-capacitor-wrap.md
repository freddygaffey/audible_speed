# 08 — Capacitor iOS + Android wrap

## 1. Goal
Native iOS and Android shells around the web app. Vite build synced to Capacitor. App runs on device/simulator.

## 2. Architecture note
The current architecture keeps download + ffmpeg on the Express server. For the native app to work:
- Web/dev: Vite proxy → localhost:3001 (Express)
- Native iOS/Android: app needs to reach the Express server by IP or a deployed URL

For v1, the app will connect to a configurable server URL. We skip on-device ffmpeg for now (step 08 scope is the Capacitor shell).

## 3. Acceptance
- `cap build ios` succeeds (no Xcode signing errors are OK — just needs to compile).
- `cap sync` copies the web bundle to ios/ and android/.
- App runs in iOS simulator and shows the player UI.

## 4. Files touched
```
artifacts/player/package.json           (add @capacitor/ios, @capacitor/android)
artifacts/player/capacitor.config.ts    (add server.url for dev pointing to local)
artifacts/player/vite.config.ts         (ensure build output matches webDir=dist)
artifacts/player/src/lib/apiClient.ts   (make base URL configurable for native)
PLAN.md
```

## 5. Risky seams
- Capacitor native app uses WKWebView (iOS) / Chromium (Android) — no localhost access.
- server.url in capacitor.config.ts can point to the dev machine IP for local testing.
- Code signing: DEVELOPMENT_TEAM must be set or `cap open ios` for manual Xcode setup.

## 6. Rollback
`git rm -r artifacts/player/ios artifacts/player/android` and revert package.json.
