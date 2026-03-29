# Phaser Migration: Detailed Fix Log and Engineering Rationale

## Context
This project migrated from a Three.js/R3F world renderer to a Phaser 2D tile/sprite renderer.
During migration, we fixed multiple rendering, layering, animation, and data-integration issues.

This document explains:
- what broke,
- why it broke,
- what was changed,
- why the new approach is correct,
- and why these issues were harder to solve cleanly in the old Three.js flow.

---

## 1) Phaser Setup Validation

### Problem
Need to confirm the repo is actually wired for Phaser (not partially migrated).

### What was validated
- `phaser` dependency present in `client/package.json`.
- `PhaserGame.tsx` mounts a `Phaser.Game` instance.
- `GameScene.ts` is active and used from the `/game` route via `World.tsx`.
- Vite/TS compile path works end-to-end.

### Outcome
Build passed and route wiring confirmed, so work proceeded on behavior bugs (not setup bugs).

---

## 2) Broken House Rendering

### Symptom
House tiles appeared corrupted/broken after migration.

### Root cause
LDtk tile records include both:
- `t` (tile id), and
- `src` (pixel source rectangle in the atlas).

For this atlas, relying on `t` directly did not map cleanly to Phaser frame indexing in all cases.

### Fix
Switched to deterministic frame derivation from `src`:
- compute frame index using `srcX/srcY` + atlas column count.
- use this mapping consistently in baked and y-sorted paths.

### Why this works
`src` is the true source-of-truth from LDtk for atlas placement.
Deriving frame from source coordinates avoids id/index mismatch edge cases.

---

## 3) Player Occlusion Through Tall Objects

### Symptom
When walking “behind” objects, top half of player could leak in front of map art.

### Root cause
Y-sorting was originally too coarse:
- first per-row assumptions,
- then per-column batching that accidentally let unrelated tiles share one depth anchor.

This caused wrong depth at specific approach angles (especially fences).

### Fix evolution
1. Moved to y-aware layering strategy.
2. Batched y-sorted content to improve performance.
3. Refined batching to **contiguous vertical segments per column**.

Final depth rule:
- each contiguous segment gets depth from its own bottom (`segmentBottomY`),
- not the absolute bottom of the whole column.

### Why this works
Depth now reflects local object geometry, not unrelated distant tiles in the same x-column.
This fixed the fence front-approach clipping case.

---

## 4) Statue Missing / Mispositioned

### Symptom
Statue initially missing, then positioned incorrectly vs LDtk design.

### Root cause
Statue is an LDtk **Entity-layer tile**, not a normal tile-layer tile.
Initial render path only handled tile layers, then entity draw needed proper bounds handling.

### Fix
- Added explicit entity-layer render pass (`Entities` layer).
- Implemented entity tile extraction and render batching.
- Anchored entity visuals using entity bounds and bottom alignment so they sit correctly on the ground line.

### Why this works
Entity visuals are now rendered from LDtk entity data (`__tile`, `px`, `width`, `height`) rather than being ignored or treated as regular tile-layer cells.

---

## 5) Cemetery Tombstone/Spade Missing

### Symptom
Gravestone/spade appeared missing after statue fix.

### Root cause
A generic “fit inside entity bounds” downscale path made small cemetery entities effectively too tiny.
Example: 32x32 tile fitted into 16x16 entity box.

### Fix
- Kept fit logic for larger props,
- but prevented downscaling below native sprite scale for tiny props:
  - `scale = max(1, fitScale)`
- maintained bottom anchoring.

### Why this works
Small grave props remain visible and grounded; larger props still respect intended placement constraints.

---

## 6) Name Label Distortion/Skew

### Symptom
Name labels above players looked distorted.

### Root cause
Tiny text rendered in a scaled camera/pixel-art pipeline can shimmer or distort when resolution/stroke sizing is too low.

### Fix
Introduced a shared label factory with:
- higher internal text resolution (`setResolution(2)`),
- stable font/stroke settings,
- controlled visual scale.

Applied this consistently to local and remote labels.

### Why this works
Rendering text at higher source resolution then scaling down improves perceived sharpness and reduces artifacts in pixel camera pipelines.

---

## 7) Movement and Animation Parity

### Symptom
Movement/animation felt off vs known-good behavior.

### Root cause
Scene animation frame selection didn’t match reference sheet semantics and timing model used in the prior implementation.

### Fix
Ported animation semantics from reference `avatarCharacter.js`:
- idle rows (2 frames) and walk rows (8 frames) mapping,
- timing: `IDLE_FPS=2`, `WALK_FPS=12`,
- time-based stepping (delta-time), not frame-count-based.

### Why this works
Animation state progression now matches the proven reference model, making motion feel familiar and deterministic across frame rates.

---

## 8) Dead Code and Code Quality Cleanup

### Removed dead/unused paths
- Unused chat bubbles state.
- Unused socket spawn-position state.
- Unused `GameBridge.playerShirtColor`.
- Unused grid helper exports not referenced by active code.
- Unused mic API surface no longer consumed by UI.
- Stale Three.js/R3F dependencies removed from client package.

### Tooling improvements
- Added ESLint config + script for TS and React hooks safety checks.
- Lint currently reports only `useVoice` exhaustive-deps warnings (no hard errors).

### Runtime safety improvement
- Hardened LDtk load/parse:
  - explicit guard for missing levels,
  - abortable fetch cleanup.

---

## Why This Was Harder in the Previous Three.js Approach

This section explains the engineering tradeoff, not a criticism of Three.js itself.

## A) Ordering model mismatch
Three.js excels at 3D scene graphs and depth buffers.
This project needs strict 2D RPG-style “feet-based” occlusion against tile/entity art.

In 2D top-down worlds:
- draw order often depends on semantic rules (tile row/segment bottoms),
- not pure z-depth.

With transparent sprite planes in Three.js, ordering often becomes manual (`renderOrder`) and brittle when many overlapping objects/entities must interleave by gameplay semantics.

## B) Tile/entity authoring pipeline fit
LDtk exports tile/entity data naturally consumed by 2D engines (tile layers + entity layers + source rects).
Phaser’s 2D render path maps directly onto that model.

In Three.js, we must emulate 2D ordering semantics on top of a 3D renderer, which increases custom logic and edge-case handling.

## C) UI/HUD/text consistency
For this style of project, Phaser + DOM HUD integration is usually simpler for:
- pixel-art sprite animation,
- tile occlusion rules,
- label placement over 2D actors.

---

## Performance Notes

Current optimizations implemented:
- baked flat layers into render textures,
- batched y-sorted tiles by contiguous segments,
- batched entity visuals per entity into render textures.

Remaining known optimization opportunity:
- game chunk size is still large due voice + runtime deps (warning from Vite). This is bundling-level, not gameplay correctness.

---

## Validation Performed

- Repeated `npm run build --prefix client` after each critical patch.
- Route/runtime wiring verified after migration.
- Scene behavior validated against reported visual regressions and user screenshots.

---

## Final State Summary

Resolved:
- broken houses,
- incorrect behind-object occlusion,
- fence front-approach clipping,
- statue visibility/placement,
- missing cemetery entities (tombstone/spade),
- distorted player labels,
- movement/animation mismatch,
- key dead-code and dependency leftovers.

Remaining caution area:
- `useVoice` hook is intentionally complex and ref-driven; lint warns on exhaustive-deps tradeoffs but runtime behavior is preserved.

