# 07 — Pitch-preserving speed 0.5×–16×

## 1. Goal
17-step speed slider (0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×, 2.5×, 3×, 3.5×, 4×, 5×, 6×, 8×, 10×, 12×, 14×, 16×). Audio remains intelligible at high speeds. Pitch preserved.

## 2. Implementation approach
Use Web Audio API's AudioWorklet with a pitch-preserving time-stretch algorithm.

Options ranked:
1. HTMLMediaElement.playbackRate (browser native, pitch compensation via preservesPitch=true where supported) — simplest, free, works up to ~4-8× in most browsers before becoming unusable.
2. soundtouch-js AudioWorklet — mature, works up to ~8×.
3. Custom WSOLA/phase-vocoder in AudioWorklet — complex but unlimited speed.

Decision: Use HTMLMediaElement.playbackRate + preservesPitch as primary (zero deps, works well to 4×). For 4×-16×, route audio through a Web Audio API node chain.

Actually, the simplest approach that actually works: use the browser's built-in playbackRate with preservesPitch. Modern Chrome supports up to 16× with reasonable quality. Test and ship.

## 3. Files touched
```
artifacts/player/src/pages/Player.tsx    (add speed slider, playbackRate)
PLAN.md
```

## 4. Risky seams
- Browser support: Chrome/Edge support playbackRate up to 16×. Firefox caps at 8×. Safari caps at 4×.
- preservesPitch (was webkitPreservesPitch): ensure it's set correctly.
- At very high speeds (>8×), quality degrades. May need Web Audio API + phase vocoder later.

## 5. Rollback
Revert commit.
