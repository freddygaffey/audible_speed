# Speed — Apple client (SwiftUI)

Native SwiftUI client for the Speed audiobook server. Targets iPhone/iPad now,
Mac next (one codebase). Replaces the retired Capacitor app (`../artifacts/player`).
The server (`../artifacts/api-server`) is unchanged — it does Amazon auth,
`.aax` download, and ffmpeg DRM-strip, and serves a Range-streamable `.m4b`.

## Why native (not PWA or Capacitor)
A deep-research pass (2026-06-21, archived in `../_research/`) confirmed that an
installed iOS PWA **cannot** reliably play backgrounded high-speed audio
(WebKit bug 261858, still open) or durably store large files. Native `AVPlayer`
gives background audio, lock-screen controls, permanent on-device caching, and
pitch-preserved speed (`AVPlayerItem.audioTimePitchAlgorithm = .timeDomain`) for
free — and the client is thin (all hard logic lives on the server), so the
cross-platform "one codebase" argument for Capacitor didn't pay for its native-bridge pain.

## Build & run (iOS Simulator)
```sh
brew install xcodegen          # once
cd apple
xcodegen generate              # (re)generate Speed.xcodeproj — rerun after adding files
open Speed.xcodeproj           # then ⌘R on an iPhone simulator
```
Or headless:
```sh
xcodebuild -project Speed.xcodeproj -scheme Speed \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```
Start the API first (from the repo root, with the Python venv on PATH):
```sh
export PATH="$PWD/artifacts/api-server/.venv/bin:$PATH"
PORT=3001 node artifacts/api-server/dist/index.mjs
```
The app defaults to `http://127.0.0.1:3001` (editable on the Sign-in screen; the
simulator reaches your Mac via loopback).

## Layout
```
Sources/App/         SpeedApp (entry), AppModel (server URL + auth state)
Sources/Networking/  APIClient (REST), Models (Codable mirrors of server JSON)
Sources/Audio/       AudioController (AVPlayer + 0.5–16× + background + now-playing)
Sources/Views/       RootView, AuthView, LibraryView, PlayerView
```

## Status
**Working:** launch, reach server, sign-in flow (drives server PKCE), library list,
download→stream→play, 0.5–16× pitch-preserved speed, skip/seek, lock-screen controls.

**Next:** offline download-to-sandbox cache (the durability win over PWA);
Settings screen (activation bytes, server URL, sign out); macOS destination;
device signing (Apple account or weekly re-sign); chapters list UI; progress sync.
