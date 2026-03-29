# World Rendering — Standards, Gaps & Migration Path

---

## Sprite Occlusion & Y-Sort — How it Works and What NOT to Change

This section documents the current sprite rendering architecture, the specific mechanism that makes player-behind-object occlusion work, and a detailed account of a breaking change that was made and reverted. Read this before touching any `transparent`, `depthTest`, `depthWrite`, or `renderOrder` values in the scene.

### The scene rendering stack

Every frame, Three.js renders objects in two sequential passes:

| Pass | Objects | Condition |
|---|---|---|
| **Opaque** | All meshes with `transparent: false` | Rendered first, writes to depth buffer |
| **Transparent** | All meshes with `transparent: true` | Rendered second, sorted by `renderOrder` then depth |

Within the opaque pass, objects are sorted front-to-back (for depth-buffer efficiency). Within the transparent pass, objects are sorted by `renderOrder` ascending, then back-to-front by depth as a tiebreaker.

**The opaque pass always completes entirely before the transparent pass begins. There is no interleaving.**

### Current layer layout (Y positions in world space)

```
Y = 0      FloorMap    (opaque ShaderMaterial, renderOrder=0, depthWrite: true)
Y = 0.005  OverlayMap  (transparent ShaderMaterial, renderOrder=1, depthTest: true)
Y = 0.01   MapObjects  (transparent MeshBasicMaterial, depthTest: false, depthWrite: false, renderOrder=spriteOrder(southEdge))
Y = 0.5    Player      (OPAQUE MeshBasicMaterial,    depthTest: true,  depthWrite: true,  renderOrder=spriteOrder(feetZ))
```

### How occlusion works — the key mechanism

Because the **player is opaque** and **map objects are transparent**, the player is always rendered in the opaque pass (first), and every map object is rendered in the transparent pass (second).

Map objects use `depthTest: false` — they completely ignore the depth buffer and unconditionally overwrite whatever pixel was rendered before them. This means **map objects always paint on top of the player**, regardless of position.

Player occlusion correctness comes entirely from **alphaTest** on the map object sprites:

```
MapObjects material: alphaTest = 0.05
  → pixels with alpha < 0.05 are DISCARDED (not rendered at all)
  → transparent sprite backgrounds never overwrite the player
  → only the actual sprite content (fence planks, house walls, etc.) overwrites
```

**Case 1 — Player walks BEHIND an object (player north of object):**

```
Screen (north = top, south = bottom):

  ████████████████   ← object's opaque sprite pixels
  ████████████████   ← object overwrites player pixels here ✓ (player hidden)
  [player pixels]    ← player visible below the object's sprite area ✓
```

The object's opaque pixels paint over the player where they overlap on screen. Player is correctly hidden.

**Case 2 — Player walks IN FRONT of an object (player south of object):**

```
Screen:

  [player upper body]  ← player rendered here (opaque pass)...
  ░░░░░░░░░░░░░░░░░░   ← ...then object tries to overwrite, but these are
  ░░░░░░░░░░░░░░░░░░      TRANSPARENT sprite background pixels → discarded ✓
  [player lower body]  ← no object pixels here at all ✓
```

The object's transparent background pixels (outside the sprite's visible area) are discarded by alphaTest. The player remains visible because nothing overwrites those pixels.

**Key insight:** Correct occlusion does not depend on renderOrder comparisons between player and objects. It depends on:
1. Player is opaque (rendered in the opaque pass, before everything transparent)
2. Sprite backgrounds are transparent (alphaTest discards background pixels)
3. Y-sort within the transparent pass (`renderOrder` = `spriteOrder(southEdge)`) ensures **objects sort correctly relative to each other** — objects further south render after (on top of) objects further north

### `spriteOrder` and `SPRITE_FEET_Z`

```ts
// utils/renderOrder.ts
export function spriteOrder(worldZ: number): number {
  return Math.round(5000 + worldZ * 100)
}

// player/AvatarMesh.tsx
export const SPRITE_ANCHOR_Z = -PLANE_SIZE * 0.1  // = -0.428 (sprite shifted slightly north)
export const SPRITE_FEET_Z   = SPRITE_ANCHOR_Z + PLANE_SIZE / 2  // = 1.712
```

`SPRITE_FEET_Z = 1.712` means the player's visual feet (south edge of the sprite plane) are 1.712 world units (tiles) south of the player's tile centre. This value is used as the Y-sort key so the player sorts correctly relative to other sprites:

```ts
// LocalPlayer.tsx — set every frame in useFrame
ref.current.traverse((obj) => {
  obj.renderOrder = spriteOrder(z + SPRITE_FEET_Z)
})
```

This makes the player's renderOrder slightly higher than the tile they're standing on, which ensures the player sorts after objects that are just north of them (correct — those objects should appear in front). But since the **player is opaque** and this renderOrder only operates within the transparent queue, it only affects player-vs-player sorting (e.g., two remote players overlapping). It has no effect on player-vs-object occlusion.

### What was tried and broke it — DO NOT repeat

In March 2026, the following change was made to `AvatarMesh.tsx` material:

```ts
// BROKEN — do not use
new MeshBasicMaterial({
  transparent: true,   // ← changed from false
  alphaTest: 0.1,
  depthTest: false,    // ← changed from true
  depthWrite: false,   // ← changed from true
})
```

**Why it seemed reasonable:** The reference project (CHANGES.md) used `depthTest: false, depthWrite: false` for all sprites. The assumption was that making all sprites consistent would improve renderOrder-based sorting.

**Why it broke:** Moving the player to `transparent: true` put the player in the transparent pass alongside all map objects. Now player-vs-object rendering is determined purely by renderOrder comparisons. But `SPRITE_FEET_Z = 1.712` shifts the player's sort key 1.712 tiles south of their actual position. A player standing at row 15 (inside the village, north of the fence at row 16) gets:

```
Player tile:   row 15   → tileZ = -14.5
Player feetZ:  -14.5 + 1.712 = -12.788
Player RO:     spriteOrder(-12.788) = 3721

Fence (row 16, south edge -13.0):
Fence RO:      spriteOrder(-13.0)   = 3700

3721 > 3700  →  player renderOrder HIGHER  →  player renders AFTER fence  →  player on top
```

But the player is **inside the village, north of the fence** — the fence should be covering the player. The 1.712-tile south offset in `SPRITE_FEET_Z` makes the player always appear "in front of" objects that are only 1–2 rows away, even when the player is actually behind them.

**The fix:** Revert to `transparent: false, depthTest: true, depthWrite: true`. This restores the opaque-first mechanism where object occlusion works via alphaTest, not renderOrder comparisons.

### Rules — what you can and cannot change

| Setting | Value | Why |
|---|---|---|
| `AvatarMesh` transparent | `false` | Must stay opaque — moves player to opaque pass |
| `AvatarMesh` depthTest | `true` | Needed for correct depth interaction with floor |
| `AvatarMesh` depthWrite | `true` | Player writes depth so OverlayMap (depthTest:true) respects it |
| `MapObjects` depthTest | `false` | Objects must paint over player unconditionally |
| `MapObjects` depthWrite | `false` | Objects must not interfere with each other's depth |
| `MapObjects` renderOrder | `spriteOrder(southEdge)` | Y-sorts objects relative to each other |
| Player renderOrder | `spriteOrder(feetZ)` | Y-sorts player relative to other players only |

**If the scene is ever refactored to billboard sprites (facing camera) or the camera gains any vertical tilt**, this system will need to be revisited. Flat ground-plane sprites with a pure overhead camera are the assumption the entire occlusion system depends on.

---

## Purpose

This document covers:
1. The industry standard for 2D top-down tile-based world rendering
2. How our current implementation differs from it
3. What needs to change and in what order

Performance is the primary concern. The goal is a correct, maintainable foundation that scales as the world grows — not a clean rewrite for its own sake.

---

## 1. Industry Standard — How It Actually Works

Games like Stardew Valley, Pokémon, Zelda, and Gather.town all use the same fundamental approach.

### Single unified world map

The entire world — ground, buildings, fences, objects, trees — is defined in **one map file** (typically Tiled `.tmx` or LDtk `.ldtk`). There is no concept of a "house component" placed on top of a "floor component". The house tiles **are** the floor tiles at those positions. Everything is layers in the same grid.

```
world.tmx
  ├── Layer: Ground          ← dirt, grass, stone paths
  ├── Layer: Ground Detail   ← puddles, cracks, texture variation
  ├── Layer: Below Player    ← rugs, floor objects, doorsteps
  ├── Layer: Buildings       ← walls, fences, exterior tiles
  ├── Layer: Above Player    ← rooftops, tree canopies, overhangs
  │                             (rendered on top of the player sprite)
  ├── Layer: Collision       ← binary walkable/blocked per tile
  └── Layer: Objects         ← spawn points, triggers, NPCs, items
                                (Tiled object layer, not a tile layer)
```

The renderer iterates layers in order and draws each one. No Y offset tricks. Draw order is explicit and authored.

### Chunk-based loading

For large open worlds, the map is divided into fixed-size chunks (typically 16×16 or 32×32 tiles). Only chunks within camera range are loaded, rendered, and kept in memory. Chunks outside range are unloaded and their GPU memory freed.

```
Visible area at zoom=60, 1920×1080 screen:
  ~32 cols × ~18 rows of tiles visible
  Load a 2-chunk margin around visible area → ~64×50 tile working set
  Everything else: unloaded
```

### Collision

A dedicated collision layer (or a per-tile boolean in the tileset metadata) marks each tile as walkable or blocked. The movement system checks this layer before applying any position delta. Players cannot walk through walls.

### Texture atlases

All tiles from a single tileset are packed into one atlas texture. The renderer samples the correct UV region per tile. One texture bind per tileset per draw call — not one texture per tile.

### Draw call budget

```
Optimal render for a 64×50 visible tile area, 8 layers:
  ~8 draw calls if all layers use the same tileset
  ~24 draw calls if 3 different tilesets across 8 layers
  (one InstancedMesh per [tileset × unique tile ID])
```

---

## 2. Current Implementation — What We Have

### FloorMap

`FloorMap.tsx` generates the world floor procedurally at module load time using a deterministic hash. It renders 4 tile variants (DIRT, DIRTV, GRASS, GRASSV) as InstancedMesh groups — **4 draw calls** for 1,800 floor tiles. This is performant and correct for the floor.

The problem: this floor renders everywhere, including under the house. It has no concept of the world map — it's a standalone procedural system.

### HouseExterior (current)

`HouseExterior.tsx` currently renders a wireframe placeholder. The plan is to parse `Exterior.tmx` and render the house tiles as a separate group of InstancedMeshes floating at `y+0.001` above the floor.

### How the two systems relate

```
FloorMap        procedural, covers the full 50×36 grid, y=0
HouseExterior   separate component, floats above FloorMap at y+0.001–0.010
```

The floor tiles from FloorMap render underneath the house with random dirt/grass — the wrong tiles for that area. The house ground layer visually covers them, which works at the current camera zoom but is incorrect data.

---

## 3. Gap Analysis

| Concern | Industry Standard | Current State | Impact |
|---|---|---|---|
| World definition | Single TMX/LDtk file, all layers | Procedural floor + separate house component | Wrong tiles under house; hard to author world layout |
| Draw order | Explicit layer order, no Y hacks | Tiny Y offset per layer (0.001) | Fragile — breaks at different zoom levels or if layers multiply |
| Collision | Dedicated collision layer, movement blocked at walls | None — players walk through everything | No spatial rules possible |
| Tileset rendering | UV atlas, one draw call per tileset per layer | Individual texture per tile type | Draw calls scale with unique tile count, not tileset count |
| World authoring | Designer edits TMX in Tiled, code re-parses | Developer writes positions in code | No designer workflow |
| Above-player layer | Roof tiles rendered on top of player sprite | Not implemented — roof always below player | Players walk behind walls, not under roofs |
| Chunk loading | Only visible chunks loaded | Entire map always loaded | Scales poorly as world grows |
| Multiple worlds | Multiple map files, load/unload per room | Single hardcoded room | No multi-world support |

---

## 4. The Core Architectural Fix

The correct foundation is a **single `WorldMap` component** that replaces both `FloorMap` and `HouseExterior`. It loads one TMX file and renders all layers — ground, buildings, objects, everything — from that one source of truth.

```
Before (current):
  World.tsx
    ├── FloorMap          ← procedural, knows nothing about Tiled
    ├── Vegetation        ← scatter-placed, no Tiled connection
    └── HouseExterior     ← floating above FloorMap

After (target):
  World.tsx
    ├── WorldMap(src="world.tmx")   ← renders all layers from one file
    └── Vegetation                  ← keep as-is (scatter detail on top)
```

The world TMX file would combine what is currently the procedural floor and the house into one authored map. The house stops being a separate component — it's just a set of layers in the world map.

---

## 5. Migration Plan

### Phase A — Fix house rendering without full rewrite (current priority)

Build `HouseExterior.tsx` as a proper Tiled layer renderer (parsing `Exterior.tmx`), keeping `FloorMap` as-is. This closes the visual gap quickly without touching the floor system.

**Remaining gaps after Phase A:**
- Floor tiles still procedural under the house (visual mismatch at close zoom)
- No collision
- Y offset draw order still in use

**When to stop at Phase A:** If the PoC remains a small single-room demo, Phase A is sufficient.

### Phase B — Unified world map (before scaling)

Replace `FloorMap` + `HouseExterior` with a single `WorldMap` renderer. Create `world.tmx` in Tiled that combines the floor and all buildings into one map.

Steps:
1. Create `world.tmx` in Tiled — author the full 50×36 world including house placement
2. Build `WorldMap.tsx` — generic Tiled layer renderer (reuses the UV atlas logic from Phase A)
3. Remove `FloorMap.tsx` and the standalone `HouseExterior.tsx`
4. Add a Collision layer to `world.tmx` — boolean walkable/blocked per tile

**When to do Phase B:** Before adding a second room, multiple buildings, or any movement-blocking features.

### Phase C — Chunk loading (before open world)

Split the world map into chunks. Load/unload chunks as the camera moves. Required when the world exceeds ~100×100 tiles or when multiple rooms need to be streamed.

**When to do Phase C:** When the world map grows beyond what fits comfortably in GPU memory (~200×200 tiles at 1 texture per tileset is fine without chunking).

---

## 6. Renderer Design — Phase A & B

### UV atlas tile sampling

Every tileset image is loaded once. Each tile's position within the atlas is computed from its local ID:

```ts
function tileUV(localId: number, tileset: TiledTileset) {
  const col       = localId % tileset.columns
  const row       = Math.floor(localId / tileset.columns)
  const totalRows = Math.ceil(tileset.tileCount / tileset.columns)
  return {
    repeatU: 1 / tileset.columns,
    repeatV: 1 / totalRows,
    offsetU: col / tileset.columns,
    offsetV: 1 - (row + 1) / totalRows,   // UV Y-axis is flipped in Three.js
  }
}
```

### Batching strategy

Group all non-zero tiles across all layers by `(tilesetImage, localTileId)`. One InstancedMesh per group. This minimises draw calls while keeping the renderer generic:

```
world.tmx with 3 tilesets, 8 layers, 200 unique tile IDs:
  → 200 InstancedMesh nodes
  → 200 draw calls

vs. per-tile approach:
  → 1 draw call per tile instance
  → potentially thousands of draw calls
```

For comparison, `FloorMap` today uses 4 draw calls for the entire floor. A full world map with rich tilesets will land in the 50–300 draw call range — acceptable for a 2D top-down game.

### Draw order

Layers are rendered in ascending order with a fixed Y offset per layer index. This replaces the ad-hoc `0.001` values currently scattered across components:

```ts
const LAYER_Y_STEP = 0.002   // world units between layers

// Layer 0 (Ground)     → y = 0.002
// Layer 1 (Road)       → y = 0.004
// Layer 5 (House_wall) → y = 0.010
// Layer 9 (Roof)       → y = 0.018
```

The above-player layer (roof) needs special handling — it renders at a higher Y but also needs to sort above the player sprite. In Three.js this is controlled via `renderOrder` on the mesh, not Y position:

```ts
// Roof layer
<mesh renderOrder={10} ...>
  <meshBasicMaterial depthTest={false} ... />
</mesh>

// Player sprite
<mesh renderOrder={5} ...>
```

### Collision

The collision layer is a tile layer where `gid > 0` means blocked. At movement time:

```ts
function isTileBlocked(worldX: number, worldZ: number): boolean {
  const col = Math.floor(worldX + MAP_COLS / 2)
  const row = Math.floor(worldZ + MAP_ROWS / 2)
  return COLLISION_LAYER[row]?.[col] > 0
}
```

This runs in O(1) per movement step — no spatial queries needed.

---

## 7. Performance Summary

| Metric | Current (Phase A complete) | Target (Phase B complete) |
|---|---|---|
| Floor draw calls | 4 (InstancedMesh) | Folded into WorldMap |
| House draw calls | ~100–200 (UV atlas, Phase A) | Same, unified |
| Total scene draw calls | ~110–210 | ~50–300 (depends on tileset count) |
| Collision | None | O(1) array lookup |
| World authoring | Code + Tiled separately | Tiled only |
| Above-player rendering | Not implemented | `renderOrder` per layer |
| Chunk loading | No (full map always loaded) | No until Phase C |

The draw call budget at Phase B is dominated by unique tile variety, not map size — InstancedMesh handles instance count efficiently. A world with 3 tilesets and 100 unique tile types will always cost ~100 draw calls regardless of whether the map is 50×36 or 500×360.
