# Swordsman Sprite Animation Plan

## Sprite Sheet Layout

`swordsman-idle.png` — 768×256px → 12 columns × 4 rows of 64×64 frames.

Assumed row layout (standard top-down RPG convention — verify against actual art):

| Row | PNG Y offset | Direction |
|-----|-------------|-----------|
| 0   | top         | Down      |
| 1   |             | Left      |
| 2   |             | Right     |
| 3   | bottom      | Up        |

Verify by opening the PNG and checking which row faces which direction.

---

## Step 1 — Derive direction in LocalPlayer

`LocalPlayer` already computes `dx` / `dz` in `useFrame`. Add a `directionRef` to track the last non-zero facing direction, and a `isMovingRef` to distinguish idle from walk:

```ts
// LocalPlayer.tsx
import type { Direction } from '../types'

const directionRef = useRef<Direction>('down')
const isMovingRef  = useRef(false)

useFrame((_, delta) => {
  const { forward, backward, left, right } = getKeys()
  const dx = (right ? 1 : 0) - (left ? 1 : 0)
  const dz = (backward ? 1 : 0) - (forward ? 1 : 0)

  if (dx !== 0 || dz !== 0) {
    isMovingRef.current = true
    // Prefer horizontal over diagonal
    if (Math.abs(dx) >= Math.abs(dz)) {
      directionRef.current = dx > 0 ? 'right' : 'left'
    } else {
      directionRef.current = dz > 0 ? 'down' : 'up'
    }
  } else {
    isMovingRef.current = false
  }

  // ... existing position update code ...
})
```

Pass both refs to `AvatarMesh` so it can drive the animation without causing re-renders.

---

## Step 2 — Add `Direction` to shared types

```ts
// types.ts
export type Direction = 'up' | 'down' | 'left' | 'right'
```

---

## Step 3 — Update AvatarMesh props

```ts
interface Props {
  avatar: Avatar
  directionRef?: React.MutableRefObject<Direction>
  isMovingRef?:  React.MutableRefObject<boolean>
}
```

Both refs are optional so box/sphere avatars are unaffected.

---

## Step 4 — Animate in SwordsmanPlane with useFrame

Replace the static `useLayoutEffect` offset with a `useFrame` loop:

```ts
// Constants (add alongside existing ones)
const ANIM_FPS        = 8        // frames per second
const WALK_FRAME_COUNT = 12      // all 12 columns are walk frames (adjust if sheet differs)
const IDLE_FRAME      = 0        // column index to show when standing still

const DIRECTION_ROW: Record<Direction, number> = {
  down:  0,
  left:  1,
  right: 2,
  up:    3,
}
```

```ts
function SwordsmanPlane({
  directionRef,
  isMovingRef,
}: {
  directionRef?: React.MutableRefObject<Direction>
  isMovingRef?:  React.MutableRefObject<boolean>
}) {
  const texture  = useTexture('/avatars/swordsman-idle.png', (tex) => {
    tex.colorSpace = SRGBColorSpace
    tex.magFilter  = NearestFilter
    tex.minFilter  = NearestFilter
    tex.wrapS      = ClampToEdgeWrapping
    tex.wrapT      = ClampToEdgeWrapping
    tex.repeat.set(1 / SWORDSMAN_IDLE_COLS, 1 / SWORDSMAN_IDLE_ROWS)
    tex.offset.set(0, (SWORDSMAN_IDLE_ROWS - 1) / SWORDSMAN_IDLE_ROWS)
  })

  const frameRef   = useRef(0)
  const elapsedRef = useRef(0)

  useFrame((_, delta) => {
    const moving    = isMovingRef?.current ?? false
    const direction = directionRef?.current ?? 'down'
    const row       = DIRECTION_ROW[direction]

    elapsedRef.current += delta

    if (elapsedRef.current >= 1 / ANIM_FPS) {
      elapsedRef.current = 0

      if (moving) {
        frameRef.current = (frameRef.current + 1) % WALK_FRAME_COUNT
      } else {
        frameRef.current = IDLE_FRAME
      }

      texture.offset.x = frameRef.current / SWORDSMAN_IDLE_COLS
      texture.offset.y = (SWORDSMAN_IDLE_ROWS - 1 - row) / SWORDSMAN_IDLE_ROWS
    }
  })

  // ... JSX unchanged ...
}
```

Note: `texture.offset.y` is flipped (`ROWS - 1 - row`) because UV Y=0 is the bottom of the image but row 0 is the top of the PNG.

---

## Step 5 — RemotePlayer direction

`RemotePlayer` lerps toward a target position each frame. Derive direction from the delta each frame:

```ts
// RemotePlayer.tsx
const directionRef = useRef<Direction>('down')
const isMovingRef  = useRef(false)

useFrame(() => {
  if (!ref.current) return
  target.set(position.x, position.y, position.z)

  const prev = ref.current.position.clone()
  ref.current.position.lerp(target, 0.15)

  const dx = ref.current.position.x - prev.x
  const dz = ref.current.position.z - prev.z
  const moving = Math.abs(dx) + Math.abs(dz) > 0.001

  isMovingRef.current = moving
  if (moving) {
    if (Math.abs(dx) >= Math.abs(dz)) {
      directionRef.current = dx > 0 ? 'right' : 'left'
    } else {
      directionRef.current = dz > 0 ? 'down' : 'up'
    }
  }
})
```

---

## Step 6 — Migrate texture setup

As a cleanup during this work, replace the `useLayoutEffect` in the current `SwordsmanPlane` with the `useTexture` callback pattern (shown in Step 4). This guarantees the texture is configured before the first render rather than one frame after.

---

## Out of scope / future

- **Attack / death animations** — requires separate sprite sheets or additional columns; add an `animationState` prop when needed.
- **Shadow** — a soft circular shadow mesh underneath the sprite improves depth perception.
- **Sprite facing for remote players** — currently uses lerped position delta; could instead be driven by a server-sent `direction` field for precision.
