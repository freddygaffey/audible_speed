# Framework

## Decision

Build the app on a **cross-platform framework** that targets iOS, Android, and the web from a single codebase. Working default: **Capacitor** (with a standard web-first UI layer on top, e.g. React or similar).

## Why cross-platform

1. **Web build is a nice-to-have feature.** Shipping the same codebase to a browser is an explicit goal (see `FEATURES.md`). A mobile-only native stack would either rule this out or force us to maintain two apps.
2. **AI coding performance.** This project is built primarily with AI assistance. Popular, well-documented cross-platform stacks have substantially more training data than niche or native-only stacks, so model output quality is higher and requires less correction. For an AI-driven solo build, this is a real productivity lever, not a minor factor.
3. **Single auth + download pipeline.** Audible PKCE auth, `.aax` fetch, and ffmpeg DRM removal can live in one shared module rather than being reimplemented per platform.

## Why Capacitor specifically (working default, not final)

- Native wrapper around a web view, so the web build comes essentially for free.
- First-class plugins for filesystem access (needed for local `.aax`/`.aaxc` storage and decrypted output) and background tasks.
- FFmpeg integration is possible via existing Capacitor plugins or a thin native bridge — important because DRM removal runs on-device.
- UI layer is whatever standard web stack we pick (React is already in use in `artifacts/libation` and is the path of least resistance).

## Alternatives considered

- **Expo / React Native** (currently in `artifacts/audiobook-player`): good mobile story but web support is second-class for audio-heavy apps. Keep it as reference, not the shipping target.
- **Flutter**: capable, but less training data than web-based stacks, and audio + FFmpeg plugin story is weaker.
- **Native iOS + Android separately**: rules out web build, doubles the work, no AI-training-data advantage.
- **PWA only**: fails the local-download / background audio / filesystem requirements on iOS.

## Open decisions

- Exact UI framework on top of Capacitor (React vs. Vue vs. Svelte). React is the working default given existing code, but this can change.
- Whether to keep or replace the current Express `api-server`. Some Audible calls may need to run server-side (user-agent / IP considerations); others can run on-device inside the Capacitor web view. TBD.
- How to ship FFmpeg on-device (prebuilt plugin vs. WASM on web + native bridge on mobile).
