# Features

## Objective

A mobile app for listening to Audible audiobooks at up to **16× speed**, bypassing Audible's native 3.5× cap. Primary daily-use app for the owner.

**Platform choice: a cross-platform framework (e.g. Capacitor).** Two reasons:
1. A web build is a nice-to-have (see below), so a framework that targets web + iOS + Android from one codebase is a better fit than native-only.
2. Popular cross-platform frameworks have more AI-training-data coverage than niche stacks, so Claude (and similar models) produce better code against them — relevant because this app is being built primarily with AI assistance.

The existing repo started as a Replit web project (Libation clone + Expo player). The Audible auth and download code in `artifacts/api-server/src/lib/` is reusable reference; the current web and Expo apps are not the target shipping surface.

## Must-have

- **Audible authentication.** PKCE OAuth against Amazon/Audible, covering the 9 supported marketplaces (US/UK/CA/AU/DE/FR/JP/IT/ES). Token refresh and session persistence on-device.
- **Download books locally.** Fetch the `.aax` (or `.aaxc`) from Audible and decrypt with the user's activation bytes via `ffmpeg -activation_bytes <hex>`. Output must be stored locally on the phone — no streaming, no dependency on network during playback. UI exposure of the downloaded files is not required; the app just needs to read them back for playback.
- **High-quality playback up to 16× speed.** 17-step speed control (0.5× – 16×, roughly the same curve as the current Expo player). Audio must remain intelligible at high speeds — use time-stretching that preserves pitch, not naive resampling.

## Nice-to-have

- **Web build.** Same codebase running in a browser, so the library + player work on desktop as well as phone. A key reason for preferring a cross-platform framework.
- **Progress sync with Audible.** Push listening position back to Audible so other Audible clients see the right spot. Not required — local-only progress is acceptable for v1.

## Out of scope (for now)

- Sharing/exporting decrypted files.
- Multi-user / account-switching flows.
- Offline-first library management beyond what's needed to play a downloaded book.
