# 09 — Background playback

## 1. Goal
Audio continues playing when the screen locks or the app is backgrounded. Lock-screen controls work.

## 2. Platform approach

**Web (Chrome/Safari)**: The HTML `<audio>` element auto-handles MediaSession API for lock-screen controls. No special work needed beyond setting `navigator.mediaSession` metadata.

**iOS (Capacitor/WKWebView)**: WKWebView can play audio in background if `UIBackgroundModes: audio` is in Info.plist and `AVAudioSession` is configured as `AVAudioSessionCategoryPlayback`. Capacitor handles this via WKWebView's `allowsBackgroundAudioPlayback`.

**Android**: Works if `<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>` and a foreground service is declared. For WKWebView on Android (Chromium), background audio is also generally supported.

## 3. Acceptance
- `navigator.mediaSession` metadata set (title, artist, artwork).
- Lock-screen controls show play/pause and ±30s.
- App info.plist has `audio` in UIBackgroundModes.
- iOS native: audio continues after screen locks.

## 4. Files touched
```
artifacts/player/src/pages/Player.tsx           (add MediaSession API)
artifacts/player/ios/App/App/Info.plist         (add UIBackgroundModes audio)
artifacts/player/android/app/src/main/AndroidManifest.xml (FOREGROUND_SERVICE permission)
PLAN.md
```

## 5. Risky seams
- MediaSession actions (seekbackward/seekforward) — set handlers.
- iOS Info.plist UIBackgroundModes must include "audio" exactly.

## 6. Rollback
Revert commit.
