# Tech Stack And Architecture Changes

## Summary
This project has moved from a mixed/legacy scene approach to a more structured Phaser-first 2D runtime with map-driven content loading, modular controllers, and improved multiplayer/voice behavior.

## 1) Rendering Stack Changes
- Migrated gameplay rendering to **Phaser 2D** scene architecture.
- Replaced ad-hoc in-scene rendering logic with reusable render pipeline modules:
  - `client/src/game/engine/layerRenderer.ts`
  - `client/src/game/content/maps/test/assetPipeline.ts`
- Added dynamic LDtk tileset key mapping (`tilesetTextureKeys`) rather than static UID mapping.
- Added NEAREST texture filtering pipeline to preserve pixel-art clarity.

## 2) Project Structure Refactor
- Split code into reusable engine vs map-specific content:
  - Reusable engine: `client/src/game/engine/*`
  - Map content (current map): `client/src/game/content/maps/test/*`
- `GameScene` is now mostly orchestration/composition logic:
  - `client/src/game/scenes/GameScene.ts`
- Removed legacy `client/src/game/scenes/gameScene` organization in favor of the new split.

## 3) Map Data + Asset Loading Changes
- `useLdtk` now parses and stores:
  - `tilesetDefs`
  - `tilesetTextureKeys`
  - `zones`
  - spawn candidates
- Tileset texture keys are generated from LDtk metadata at runtime.
- Added spawn filtering to avoid spawning inside visual entities (e.g., statue footprint), even when collision CSV is walkable.

## 4) Movement System Changes
- Reworked local movement from strict tile-step feel toward smoother movement handling.
- Preserved server contract compatibility:
  - Server expects max 1-tile Manhattan step per move packet.
  - Client now emits movement in bounded single-tile network steps to avoid `step violation` bursts.
- Direction facing logic aligned to cardinal frame sets (4-direction sheets).
- Input behavior improved for chat UX:
  - Disabled Phaser capture for `W/A/S/D/E`.
  - Removed SPACE capture so chat typing works.
  - Clicking outside chat blurs input and returns control to movement.

## 5) Interaction System Changes
- Introduced dedicated controllers for interaction domains:
  - NPC: `npcInteractionController.ts`
  - Gravestone: `graveInteractionController.ts`
  - Statue lore: `statueInteractionController.ts`
- Consolidated duplicate UI logic into shared utilities:
  - `interactionUi.ts`
  - `interactionUtils.ts`
- Improved prompt/panel handling and close-hit behavior consistency.

## 6) NPC/Trader Animation Changes
- Added dedicated trader animation controller:
  - `client/src/game/content/maps/test/traderAnimationController.ts`
- Supports idle/dialog state switching and frame-strip playback from trader atlases.
- Added stronger separation between content animation config and engine rendering logic.

## 7) Voice Stack Stability Improvements
- Hardened mic/VAD pipeline for problematic devices:
  - Added preferred 48kHz voice AudioContext creation.
  - Added clearer fallback behavior/logging when Silero VAD is unavailable.
- Continued analyzer fallback path when VAD init fails (e.g., low native sample rate environments).

## 8) Network/Multiplayer Behavior Adjustments
- Improved client move emission behavior to reduce invalid movement packets against server anti-teleport checks.
- Kept server-authoritative movement validation unchanged while making client behavior compatible with smoother local motion.

## 9) Why These Changes Were Made
- Improve maintainability: smaller modules, clearer ownership boundaries.
- Improve scalability: map-specific data/config separated from core engine code.
- Improve player feel: smoother movement and better interaction UX.
- Improve reliability: resilient voice fallback and safer network movement emission.

## 10) Current State
- Build is green after refactors.
- Core runtime is now modular and ready for additional maps/content packs.
- Existing map behavior remains functional while architecture is significantly cleaner.
