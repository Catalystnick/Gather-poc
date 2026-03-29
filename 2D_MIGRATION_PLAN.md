# 2D Migration Plan — XZ Plane → XY Plane

## Goal

Move from a 3D-template-style setup (world on XZ plane, camera above on Y) to a proper 2D
orthographic setup (world on XY plane, camera in front on Z). This matches how the
`order rendering test` project works and eliminates the confusing axis mismatch where
"Y-sort" actually sorts by Z.

**Before:** X = east/west | Y = camera height | Z = north/south
**After:**  X = east/west | Y = north/south   | Z = unused (all 0, camera on Z)

---

## Coordinate Mapping Reference

| Concept              | Before (XZ)                  | After (XY)                   |
|----------------------|------------------------------|------------------------------|
| Tile → world pos     | `x = OX + col`, `z = OZ + row` | `x = OX + col`, `y = OY + row` |
| Object position      | `[x, yOffset, z]`            | `[x, y, 0]`                  |
| Object rotation      | `[-Math.PI/2, 0, 0]`         | none (faces camera naturally)|
| Camera position      | `[0, 20, 0]`                 | `[0, 0, 100]`                |
| Camera lookAt        | `(x, 0, z)`                  | `(x, y, 0)`                  |
| Camera up vector     | `(0, 0, -1)`                 | `(0, 1, 0)` (default)        |
| Y-sort key           | world Z                      | world Y (inverted — lower Y = further north = renders behind) |
| Player spawn Y       | `0.5` (hip height above floor)| `0` (flat, no height needed) |

### Y-sort direction note
In XZ: larger Z = further south = higher renderOrder = draws on top. ✓
In XY: Y increases upward (north), but further south = lower Y. So the formula flips:

```
// Before:
renderOrder = SPRITE_BASE + worldZ * SPRITE_SCALE

// After:
renderOrder = SPRITE_BASE - worldY * SPRITE_SCALE
```

---

## Files to Change

### 1. `client/src/utils/gridHelpers.ts`

**What changes:** `tileToWorld` currently returns `{ x, z }`. Change it to return `{ x, y }`.
Row 0 = top of map = highest Y. Row 59 = bottom of map = lowest Y. This mirrors how the
order rendering test project converts map rows to world Y.

```ts
// Before:
const OX = -(COLS * TILE_SIZE) / 2  // -30
const OZ = -(ROWS * TILE_SIZE) / 2  // -30

export function tileToWorld(col: number, row: number): { x: number; z: number } {
  return {
    x: OX + col * TILE_SIZE + TILE_SIZE / 2,
    z: OZ + row * TILE_SIZE + TILE_SIZE / 2,
  }
}

// After:
const OX = -(COLS * TILE_SIZE) / 2   // -30
const OY =  (ROWS * TILE_SIZE) / 2   // +30  (row 0 = top = highest Y)

export function tileToWorld(col: number, row: number): { x: number; y: number } {
  return {
    x: OX + col * TILE_SIZE + TILE_SIZE / 2,
    y: OY - row * TILE_SIZE - TILE_SIZE / 2,  // row increases downward, Y decreases
  }
}
```

---

### 2. `client/src/utils/renderOrder.ts`

**What changes:** Flip the sort direction. Lower Y = further south = should render on top.

```ts
// Before:
export function spriteOrder(worldZ: number): number {
  return Math.round(SPRITE_BASE + worldZ * SPRITE_SCALE)
}

// After:
export function spriteOrder(worldY: number): number {
  return Math.round(SPRITE_BASE - worldY * SPRITE_SCALE)
}
```

Rename the parameter from `worldZ` to `worldY` throughout the file for clarity.

---

### 3. `client/src/components/scene/CameraRig.tsx`

**What changes:** Camera moves from above (Y axis) to in front (Z axis). Remove `camera.up`
override — the default `(0, 1, 0)` is correct for XY. Track player Y instead of Z.

```ts
// Before (lines 31-42):
camera.up.set(0, 0, -1)
camera.position.set(0, 20, 0)
camera.lookAt(0, 0, 0)

// After:
// camera.up stays default (0, 1, 0) — remove the .up.set() call
camera.position.set(0, 0, 100)
camera.lookAt(0, 0, 0)
```

```ts
// Before (lines 96-100):
camera.position.x = MathUtils.lerp(camera.position.x, tx, LERP)
camera.position.z = MathUtils.lerp(camera.position.z, tz, LERP)
camera.lookAt(camera.position.x, 0, camera.position.z)

// After:
camera.position.x = MathUtils.lerp(camera.position.x, tx, LERP)
camera.position.y = MathUtils.lerp(camera.position.y, ty, LERP)
camera.lookAt(camera.position.x, camera.position.y, 0)
```

Where `tx` and `ty` come from the player's world X and Y (from `tileToWorld`).

---

### 4. `client/src/components/player/LocalPlayer.tsx`

**What changes:** All `position.z` references become `position.y`. Player Y offset (0.5) is
removed — there is no floor to hover above.

- Line 76–77: `const { x, z } = tileToWorld(...)` → `const { x, y } = tileToWorld(...)`
- Line 77: `ref.current.position.set(x, 0.5, z)` → `ref.current.position.set(x, y, 0)`
- Line 151: `const { x, z } = tileToWorld(...)` → `const { x, y } = tileToWorld(...)`
- Lines 153, 171: All `.position.z` → `.position.y`
- Line 199: `spriteOrder(z + SPRITE_FEET_Z)` → `spriteOrder(y + SPRITE_FEET_Y)`
- Line 214: `tweenFromZRef.current = ref.current.position.z` → use `.position.y`
- All `tweenFromZRef`, `tweenToZRef` → rename to `tweenFromYRef`, `tweenToYRef`

---

### 5. `client/src/components/player/RemotePlayer.tsx`

Same pattern as LocalPlayer:

- Line 54–55: `const { x, z } = tileToWorld(...)` → `const { x, y } = tileToWorld(...)`
- Line 55: `position.set(x, 0.5, z)` → `position.set(x, y, 0)`
- Lines 71, 88, 94, 98: All `.position.z` → `.position.y`
- Line 100: `spriteOrder(pz + SPRITE_FEET_Z)` → `spriteOrder(py + SPRITE_FEET_Y)`
- Rename all `tweenFromZRef`, `tweenToZRef` → `tweenFromYRef`, `tweenToYRef`

---

### 6. `client/src/components/player/AvatarMesh.tsx`

**What changes:** Remove the `rotation={[-Math.PI/2, 0, 0]}` from the mesh — sprites face the
camera naturally in XY. Rename Z constants to Y.

```ts
// Before:
export const SPRITE_ANCHOR_Z = -PLANE_SIZE * 0.1   // -0.2
export const SPRITE_FEET_Z   = SPRITE_ANCHOR_Z + PLANE_SIZE / 2  // 1.8 (south offset)

// After:
export const SPRITE_ANCHOR_Y = -PLANE_SIZE * 0.1   // -0.2 (same offset logic, now in Y)
export const SPRITE_FEET_Y   = SPRITE_ANCHOR_Y - PLANE_SIZE / 2  // -1.2
// Note: feet = bottom of sprite = lower Y, so subtract instead of add
```

Remove `rotation={[-Math.PI / 2, 0, 0]}` from the mesh JSX (line 214).

---

### 7. `client/src/components/player/ChatBubble.tsx`

**What changes:** Bubble offset is currently `-1.2` in Z (north of player). In XY, north =
higher Y, so move it in the +Y direction.

```tsx
// Before:
<Html position={[0, 0, -1.2]} center>

// After:
<Html position={[0, 1.2, 0]} center>
```

---

### 8. `client/src/components/player/PlayerLabel.tsx`

**What changes:** Label is currently at Y=0.5, Z=-1.6, rotated flat. In XY it should sit
above the sprite (+Y) with no rotation.

```tsx
// Before:
<Text position={[0, 0.5, -1.6]} rotation={[-Math.PI / 2, 0, 0]}>

// After:
<Text position={[0, 1.6, 0]}>
```

---

### 9. `client/src/components/player/StatusRing.tsx`

**What changes:** Ring is currently rotated flat. In XY it faces camera naturally.
Remove rotation. Y offset becomes 0 (ring sits at same level as player center).

```tsx
// Before:
<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>

// After:
<mesh position={[0, 0, 0]}>
```

---

### 10. `client/src/components/scene/FloorMap.tsx`

**What changes:** Tile positions stored in the `POSITIONS` array currently use `[x, z]`.
Change to `[x, y]` using the same row→Y conversion as `tileToWorld`. Remove `rotation.x`
from the dummy object.

```ts
// Before (lines 81-88):
const OX = -(COLS * TILE_SIZE) / 2
const OZ = -(ROWS * TILE_SIZE) / 2
POSITIONS[i * 2]     = OX + c * TILE_SIZE + TILE_SIZE / 2  // X
POSITIONS[i * 2 + 1] = OZ + r * TILE_SIZE + TILE_SIZE / 2  // Z

// After:
const OX = -(COLS * TILE_SIZE) / 2
const OY =  (ROWS * TILE_SIZE) / 2
POSITIONS[i * 2]     = OX + c * TILE_SIZE + TILE_SIZE / 2  // X (unchanged)
POSITIONS[i * 2 + 1] = OY - r * TILE_SIZE - TILE_SIZE / 2  // Y (row 0 = top = highest Y)
```

```ts
// Before (line 149):
_dummy.rotation.x = -Math.PI / 2

// After:
// Remove this line entirely — PlaneGeometry faces +Z by default, which is toward the camera
```

```ts
// Before (line 193):
_dummy.position.set(POSITIONS[i * 2], 0, POSITIONS[i * 2 + 1])

// After:
_dummy.position.set(POSITIONS[i * 2], POSITIONS[i * 2 + 1], 0)
```

---

### 11. `client/src/components/scene/OverlayMap.tsx`

Same pattern as FloorMap:

- Change `OZ` to `OY` with the same inversion formula
- `POSITIONS[i * 2 + 1]` uses `OY - r * TILE_SIZE - TILE_SIZE / 2`
- Remove `_dummy.rotation.x = -Math.PI / 2` (line 78)
- `_dummy.position.set(POSITIONS[i * 2], 0.005, POSITIONS[i * 2 + 1])`
  → `_dummy.position.set(POSITIONS[i * 2], POSITIONS[i * 2 + 1], 0)`
  (the `0.005` Y offset to prevent z-fighting is no longer needed — use `renderOrder` instead)

---

### 12. `client/src/components/scene/MapObjects.tsx`

**What changes:** `MapObjects` becomes the single renderer for all world objects —
static sprites, fences, and animated sprites (campfire etc.). `Fence.tsx` and
`Campfire.tsx` are both deleted; their rendering folds in here.

**Coordinate fix** — `obj.z` → `obj.y`, rotation removed, Y-sort uses south edge:
```tsx
// Before:
const ro = spriteOrder(obj.z + obj.h / 2)
<mesh position={[obj.x, 0.01, obj.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ro}>

// After:
const ro = spriteOrder(obj.y - obj.h / 2)  // south edge = center Y - half height
<mesh position={[obj.x, obj.y, 0]} renderOrder={ro}>
```

**Animated objects** — add `AnimatedObjectMesh` alongside the existing `ObjectMesh`.
Routing is data-driven via the `anim` field:

```tsx
// Static object — unchanged logic, new coords
function ObjectMesh({ obj, texture }: ObjectMeshProps) { ... }

// Animated object — advances texture.offset.x each frame
function AnimatedObjectMesh({ obj, texture }: ObjectMeshProps) {
  const sprite = useMemo(() => {
    const t = texture.clone()
    t.repeat.set(1 / obj.anim!.frames, 1)
    t.needsUpdate = true
    return t
  }, [texture, obj.anim])

  const elapsed = useRef(0)
  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.1)
    if (elapsed.current >= 1 / obj.anim!.fps) {
      elapsed.current -= 1 / obj.anim!.fps
      sprite.offset.x = ((sprite.offset.x * obj.anim!.frames + 1) % obj.anim!.frames) / obj.anim!.frames
    }
  })

  const ro = spriteOrder(obj.y - obj.h / 2)
  return (
    <mesh position={[obj.x, obj.y, 0]} renderOrder={ro}>
      <planeGeometry args={[obj.w, obj.h]} />
      <meshBasicMaterial map={sprite} transparent alphaTest={0.1} depthTest={false} depthWrite={false} />
    </mesh>
  )
}

// Router — picks component based on data
{mapData.objects.map((obj, i) => {
  const tex = texByPath.get(obj.src)
  if (!tex) return null
  return obj.anim
    ? <AnimatedObjectMesh key={i} obj={obj} texture={tex} />
    : <ObjectMesh key={i} obj={obj} texture={tex} />
})}
```

Any future animated object (torch, water, chest) requires zero new components — just
add an `anim` field to its entry in `map.json`.

---

### 13. `client/src/components/scene/Fence.tsx` → DELETED

**What changes:** `Fence.tsx` is deleted entirely. Fence visual rendering moves into
`MapObjects.tsx` (fences are just sprites — no special component needed). Fence collision
moves into `collisionSystem.ts` (see section 14) driven by the `collision` property on
objects in `map.json`.

The visual data previously in `WORLD_FENCES` / `WORLD_FENCE_OBJECTS` in `worldMap.ts`
is replaced by entries in `map.json` `objects` array with `collision: true` where applicable.

---

### 14. `client/src/utils/fenceCollision.ts` → renamed `collisionSystem.ts`

**What changes:** No longer fence-specific. Reads any `WorldObject` with `collision: true`
from `mapData.objects` and derives AABB wall segments from its `x, y, w, h`. The file is
renamed `collisionSystem.ts` to reflect that it handles all collidable objects, not just
fences.

```ts
// Before — hardcoded to WORLD_FENCES, fence-edge logic:
import { WORLD_FENCES } from '../data/worldMap'
type HWall = { axis: "z"; coord: number; xMin: number; xMax: number }
type VWall = { axis: "x"; coord: number; zMin: number; zMax: number }

function buildWalls(): Wall[] {
  for (const f of WORLD_FENCES) {
    const wz = OZ + f.row
    if (f.offsetZ === 0 || f.offsetZ === 1)
      walls.push({ axis: "z", coord: wz + f.offsetZ, xMin: wx, xMax: wx + 1 })
    if (f.offsetX === 0 || f.offsetX === 1)
      walls.push({ axis: "x", coord: wx + f.offsetX, zMin: wz, zMax: wz + 1 })
  }
}
export function resolveCollision(ox: number, oz: number, nx: number, nz: number): [number, number]

// After — generic, driven by map.json collision flag, XY axis:
import type { WorldObject } from '../types/mapTypes'
type HWall = { axis: "y"; coord: number; xMin: number; xMax: number }
type VWall = { axis: "x"; coord: number; yMin: number; yMax: number }

export function buildWalls(objects: WorldObject[]): Wall[] {
  const walls: Wall[] = []
  for (const o of objects.filter(o => o.collision)) {
    const left   = o.x - o.w / 2;  const right = o.x + o.w / 2
    const top    = o.y + o.h / 2;  const bottom = o.y - o.h / 2
    walls.push({ axis: "y", coord: top,    xMin: left,  xMax: right }) // north edge
    walls.push({ axis: "y", coord: bottom, xMin: left,  xMax: right }) // south edge
    walls.push({ axis: "x", coord: left,   yMin: bottom, yMax: top  }) // west edge
    walls.push({ axis: "x", coord: right,  yMin: bottom, yMax: top  }) // east edge
  }
  return walls
}

export function resolveCollision(ox: number, oy: number, nx: number, ny: number, walls: Wall[]): [number, number]
```

`buildWalls()` is called once in `World.tsx` after `mapData` loads and the result is passed
down to `LocalPlayer` via props or context. No module-level singleton — walls are derived
from live map data.

The `resolveCollision` signature gains a `walls` parameter (replaces the module-level
`WALLS` constant) so it works with whatever data was loaded at runtime.

---

### 15. `client/src/components/scene/PlacementTool.tsx`

**Yes — this is affected**, but only the coordinate math and the export step. The leva
controls themselves, the `writeTile` live-editing, and localStorage fence drafts all
continue to work as-is.

**Coordinate changes** (same pattern as Fence + FloorMap):
- Replace `OZ` with `OY` using the inversion formula
- `position={[x, 0.015, z]}` → `position={[x, y, 0]}`
- Remove `rotation={[-Math.PI/2, 0, 0]}` from all ghost/preview meshes
- `tileGhostZ` → `tileGhostY` with inverted formula
- Rename leva label `'Z edge (0=top, 0.5=center, 1=bottom)'` → `'Y edge'` for clarity

**Export step** — see the Runtime Loading section below. The `Export Map` button currently
copies a TypeScript snippet to clipboard for pasting into `worldMap.ts`. After the
migration it should instead trigger a JSON file download that replaces
`public/assets/map.json`. Change in the button callback:

```ts
// Before — copies TS to clipboard:
const snippet = `export const WORLD_MAP = new Uint8Array([${Array.from(MAP).join(',')}])\n...`
navigator.clipboard?.writeText(snippet)

// After — downloads map.json:
const data = {
  tiles:   Array.from(MAP),
  overlay: Array.from(OVERLAY_MAP),   // see Runtime Loading section
  fences:  fencesRef.current,
  zones:   zones,
  objects: WORLD_OBJECTS,             // pass in as prop or import
}
const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
const url  = URL.createObjectURL(blob)
const a    = document.createElement('a')
a.href = url; a.download = 'map.json'; a.click()
URL.revokeObjectURL(url)
```

The downloaded file goes into `client/public/assets/map.json` to replace the existing one.

---

### 16. `client/src/data/worldMap.ts` → replaced by `client/public/assets/map.json`

**What changes:** This file is deleted. All data it contains moves to a JSON file that is
fetched at runtime. See the Runtime Loading section below for the full replacement.

The `WorldObject` interface (and `PlacedFence` type) move to a new
`client/src/types/mapTypes.ts` file so they can be shared between components without
importing from the old data file:

```ts
// client/src/types/mapTypes.ts

export interface AnimDef {
  frames: number   // number of horizontal frames in the sprite sheet
  fps:    number   // playback speed
}

export interface WorldObject {
  src:        string
  x:          number       // world X center
  y:          number       // world Y center (Y-up, replaces old z field)
  w:          number
  h:          number
  collision?: boolean      // true = AABB walls derived from x/y/w/h at runtime
  anim?:      AnimDef      // present = animated sprite sheet, absent = static
}

export interface MapData {
  tiles:   number[]
  overlay: number[]
  objects: WorldObject[]   // includes fences, houses, campfire, all world objects
  zones:   Zone[]
}
```

**`PlacedFence` is removed** — fences are now regular `WorldObject` entries in the
`objects` array with `collision: true`. The separate fence data structure is gone.

The TMX extract script is responsible for reading the `Collision` object property and
writing `collision: true` into the JSON, and reading animation frame metadata for
animated objects and writing the `anim` field.

---

### 17. Runtime Map Loading — replaces `worldMap.ts`

**New file: `client/public/assets/map.json`**

This file is the single source of truth for all map data. It is fetched at startup and
never imported as TypeScript. Structure:

```json
{
  "tiles":   [1, 1, 1, ...],
  "overlay": [0, 0, 5, ...],
  "objects": [
    { "src": "/objects/village/house/1.png", "x": -25.06, "y": 25, "w": 3.625, "h": 3.5, "collision": true },
    { "src": "/objects/fence/1.png",         "x": 5.5,    "y": 10, "w": 1,     "h": 1,   "collision": true },
    { "src": "/floor-map/3-Animated-Objects/2-Campfire/2.png", "x": 0, "y": 0, "w": 2, "h": 2, "anim": { "frames": 6, "fps": 8 } }
  ],
  "zones":   [{ "key": "dev", "x": 0, "y": 0, "width": 10, "depth": 10 }]
}
```

**New hook: `client/src/hooks/useMapData.ts`**

Fetches and parses the JSON once. Returns `null` while loading so consumers can suspend
or show a fallback.

```ts
import { useState, useEffect } from 'react'
import type { MapData } from '../types/mapTypes'

let cached: MapData | null = null

export function useMapData(): MapData | null {
  const [data, setData] = useState<MapData | null>(cached)
  useEffect(() => {
    if (cached) return
    fetch('/assets/map.json')
      .then(r => r.json())
      .then((d: MapData) => { cached = d; setData(d) })
  }, [])
  return data
}
```

The module-level `cached` variable means the JSON is only fetched once even if multiple
components call the hook.

**`client/src/components/scene/FloorMap.tsx`**

Currently imports `WORLD_MAP` from `worldMap.ts` and copies it into a mutable `MAP`
Uint8Array at module load. Replace with the fetched data:

```ts
// Before:
import { WORLD_MAP } from '../../data/worldMap'
export const MAP = new Uint8Array(TOTAL)
if (WORLD_MAP) MAP.set(WORLD_MAP)

// After:
// MAP is still a mutable Uint8Array — writeTile() and PlacementTool still work unchanged.
// It just gets populated from the fetched data instead of an import.
export const MAP = new Uint8Array(TOTAL)

// In the FloorMap component, receive mapData as a prop (passed from World.tsx):
export default function FloorMap({ mapData, uvAttrRef }: Props) {
  useEffect(() => {
    if (mapData) {
      MAP.set(mapData.tiles)
      // rebuild instanced mesh UVs...
    }
  }, [mapData])
  // ...
}
```

**`client/src/components/scene/OverlayMap.tsx`**

Same pattern — receives `mapData.overlay` as a prop instead of importing `ROAD_STONES_MAP`.

**`client/src/components/scene/Fence.tsx`**

Receives `mapData.fences` as a prop instead of importing `WORLD_FENCES`.

**`client/src/components/scene/MapObjects.tsx`**

Receives `mapData.objects` as a prop instead of importing `WORLD_OBJECTS`.

**`client/src/components/scene/World.tsx`**

Becomes the single place that calls `useMapData()` and fans the data out to children:

```tsx
export default function World() {
  const mapData = useMapData()
  if (!mapData) return <LoadingScreen />

  return (
    <Canvas orthographic>
      <FloorMap mapData={mapData} uvAttrRef={uvAttrRef} />
      <OverlayMap mapData={mapData} />
      <Fence mapData={mapData} />
      <MapObjects mapData={mapData} />
      ...
    </Canvas>
  )
}
```

**How to create the initial `map.json`**

`worldMap.ts` was authored against the wrong coordinate system. The values it stores for
the north/south axis are simply wrong numbers that need to be corrected once. Write a
one-time migration script — run it, output `map.json`, then delete `worldMap.ts` and the
script. Everything downstream of `map.json` is XY-only with no knowledge of how the data
was originally stored.

```ts
// scripts/export-map-json.ts — run once, then delete
import { WORLD_MAP, ROAD_STONES_MAP, WORLD_OBJECTS, WORLD_FENCE_OBJECTS, WORLD_ZONES } from '../src/data/worldMap'
import { writeFileSync } from 'fs'

const mapJson = {
  tiles:   Array.from(WORLD_MAP),
  overlay: Array.from(ROAD_STONES_MAP),
  objects: [
    ...WORLD_OBJECTS.map(({ src, x, z, w, h }) => ({
      src, x, y: -z, w, h
    })),
    ...WORLD_FENCE_OBJECTS.map(({ src, x, z, w, h }) => ({
      src, x, y: -z, w, h, collision: true
    })),
  ],
  zones: WORLD_ZONES.map(({ key, x, z, width, depth }) => ({
    key, x, y: -z, width, depth
  }))
}

writeFileSync('client/public/assets/map.json', JSON.stringify(mapJson, null, 2))
```

The `-z` conversion exists only inside this script and only because the source data was
wrong. Once `map.json` exists and `worldMap.ts` is deleted, `y: -z` disappears from the
codebase entirely.

---

### 19. `client/src/utils/usePixelTexture.ts` (new file)

**What changes:** `NearestFilter` and `generateMipmaps: false` are currently repeated
in every component that loads a texture — `AvatarMesh`, `Campfire`, `Fence`, `FloorMap`,
`MapObjects`, `OverlayMap`, `PlacementTool`. Extract into a shared hook.

```ts
// client/src/utils/usePixelTexture.ts
import { useTexture } from '@react-three/drei'
import { NearestFilter } from 'three'
import type { Texture } from 'three'

function applyPixelFilters(tex: Texture) {
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.generateMipmaps = false
}

export function usePixelTexture(url: string): Texture {
  return useTexture(url, (tex) => applyPixelFilters(tex))
}

export function usePixelTextures(urls: string[]): Texture[] {
  return useTexture(urls, (textures) => {
    const arr = Array.isArray(textures) ? textures : [textures]
    arr.forEach(applyPixelFilters)
  }) as Texture[]
}
```

Then replace the repeated boilerplate in every component:

```ts
// Before (repeated in 7 files):
const tex = useTexture('/path/to/sprite.png')
useMemo(() => {
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
}, [tex])

// After:
const tex = usePixelTexture('/path/to/sprite.png')
```

`generateMipmaps: false` is currently missing in most components — this hook ensures
it is consistently set everywhere, saving GPU memory.

---

### 21. `client/src/hooks/useVoice.ts`

**What changes:** Voice proximity uses Z in distance calculation. Replace with Y.

```ts
// Before (line 100):
const dist = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)

// Line 104:
const { x, z } = tileToWorld(p.col, p.row)

// After:
const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)

const { x, y } = tileToWorld(p.col, p.row)
```

---

### 22. `client/src/components/scene/PlacementHUD.tsx`

Dev-only display. Update `OZ`/`wz` references to `OY`/`wy`.

```ts
// Before:
const OZ = -(ROWS / 2)
const wz = (OZ + row).toFixed(1)

// After:
const OY = ROWS / 2
const wy = (OY - row).toFixed(1)
```

---

### 23. `client/src/components/scene/Campfire.tsx` → DELETED

Animation and placement handled by `AnimatedObjectMesh` inside `MapObjects.tsx` via the
`anim` field in `map.json`. No code changes needed here — just delete the file.

---

### 24. `client/src/components/scene/World.tsx`

**What changes:** GridHelper + spawn position initialization.

```tsx
// Before (line 88):
<gridHelper args={[60, 60, '#444444', '#2a2a2a']} position={[0, 0.02, 0]} />

// After — gridHelper doesn't make sense in 2D. Replace with a simple plane or remove it.
// If keeping for debug: use a custom line grid in the XY plane instead.
```

```ts
// Before (line 51):
const { x, z } = tileToWorld(spawnPosition.col, spawnPosition.row)

// After:
const { x, y } = tileToWorld(spawnPosition.col, spawnPosition.row)
```

---

## Suggested Order of Changes

Do these in order to keep the project in a working state at each step:

1. **`mapTypes.ts`** (new file) — define `WorldObject` (with `collision?` + `anim?`), `AnimDef`, `MapData`
2. **`usePixelTexture.ts`** (new file) — extract repeated NearestFilter boilerplate before touching any component
3. **`map.json`** (new file) — create initial JSON from existing `worldMap.ts`; fold fence + campfire data into `objects` array with `collision` and `anim` fields
4. **`useMapData.ts`** (new hook) — fetch and cache the JSON
5. **`gridHelpers.ts`** — foundation for all coordinate conversions
6. **`renderOrder.ts`** — update formula and rename param
7. **`CameraRig.tsx`** — get the camera right before anything is visible
8. **`FloorMap.tsx`** + **`OverlayMap.tsx`** — get the floor visible; switch to runtime data; swap to `usePixelTexture`
9. **`MapObjects.tsx`** — fold in fence + animated object rendering; add `AnimatedObjectMesh`; switch to runtime data; swap to `usePixelTexture`
10. **`collisionSystem.ts`** (rename from `fenceCollision.ts`) — generic AABB collision from `collision: true` objects
11. **`World.tsx`** — wire `useMapData`, fan data to children, call `buildWalls()` once after load
12. **`LocalPlayer.tsx`** + **`AvatarMesh.tsx`** — get the character appearing in the right place; swap to `usePixelTexture`
13. **`RemotePlayer.tsx`** — same as local player
14. **`PlacementTool.tsx`** + **`PlacementHUD.tsx`** — update coords + fix export to download JSON; swap to `usePixelTexture`
15. **`ChatBubble.tsx`**, **`PlayerLabel.tsx`**, **`StatusRing.tsx`** — cosmetic, fix last
16. **Delete** `Fence.tsx`, `Campfire.tsx`, `worldMap.ts`, `scripts/extract-tmx.mjs`

---

## Things That Do NOT Change

- `tileUV.ts` — pure texture math, no world coordinates
- `canMove.ts` / `tileMap.ts` — operates on tile (col, row) grid, not world space
- Server-side code — movement is communicated in tile (col, row), never world coordinates
- All network/socket code — uses tile coords throughout
- The leva controls UI in `PlacementTool` — only the export button and coordinate math change
- `writeTile()` in `FloorMap` — still mutates the same in-memory `MAP` Uint8Array, unchanged
- Animation playback logic — same frame-advance pattern as current `Campfire.tsx`, just moved into `AnimatedObjectMesh`
- Collision resolution logic — same AABB push-back math as current `fenceCollision.ts`, just made generic
