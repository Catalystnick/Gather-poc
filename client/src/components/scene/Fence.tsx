import { useRef, useMemo, useEffect } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

// ─── World constants (must match FloorMap) ────────────────────────────────────
const TILE_SIZE = 1
const MAP_COLS  = 50
const MAP_ROWS  = 36
const HALF_W    = (MAP_COLS * TILE_SIZE) / 2   // 25
const HALF_H    = (MAP_ROWS * TILE_SIZE) / 2   // 18

// ─── Fence layout ─────────────────────────────────────────────────────────────
// Divide the 50-col world into 3 equal sections (~16.67 cols each).
// Fence lines sit at the boundaries between sections.
//   Section 1: X -25  → -8.33   (cols 0–16)
//   Section 2: X -8.33 → +8.33  (cols 17–32)  ← spawn (0,0) is here
//   Section 3: X +8.33 → +25    (cols 33–49)
const FENCE_X_POSITIONS = [-(MAP_COLS / 6), MAP_COLS / 6] as const  // ≈ -8.33, +8.33

// ─── Sprite sizing ────────────────────────────────────────────────────────────
// Scale: 32 px = 1 world unit, ×1.8 upscale — matches Vegetation.tsx exactly.
// Rail section  1.png → 27×15 px
// Post          7.png → 7×31 px
const PX = (px: number) => (px / 32) * 1.8

const RAIL_W = PX(27)   // width along Z (the fence line direction)
const RAIL_H = PX(15)   // depth along X

const POST_W = PX(7)
const POST_H = PX(31)

// ─── Instance positions ───────────────────────────────────────────────────────
// Rails: one per tile row along each fence line
// Posts: every 4 tile rows along each fence line, offset by half a tile so
//        they sit at natural column boundaries
function buildPositions() {
  const rails: Array<[number, number]> = []
  const posts: Array<[number, number]> = []

  for (const fx of FENCE_X_POSITIONS) {
    for (let r = 0; r < MAP_ROWS; r++) {
      const z = -HALF_H + r * TILE_SIZE + TILE_SIZE / 2
      rails.push([fx, z])
      if (r % 4 === 0) posts.push([fx, z])
    }
  }

  return { rails, posts }
}

const { rails: RAIL_POS, posts: POST_POS } = buildPositions()

// Reusable dummy — never rendered, only used for matrix calculation.
// Rail orientation: flat on ground (-X), long axis running along Z (+Y).
const _railDummy = new THREE.Object3D()
_railDummy.rotation.set(-Math.PI / 2, Math.PI / 2, 0)

// Post orientation: flat on ground, long axis running along Z.
const _postDummy = new THREE.Object3D()
_postDummy.rotation.set(-Math.PI / 2, Math.PI / 2, 0)

// ─── Sub-component: one InstancedMesh layer ───────────────────────────────────
interface LayerProps {
  positions: Array<[number, number]>
  texture: THREE.Texture
  width: number
  height: number
  yOffset: number
  dummy: THREE.Object3D
}

function FenceLayer({ positions, texture, width, height, yOffset, dummy }: LayerProps) {
  const ref = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    if (!ref.current) return
    positions.forEach(([x, z], i) => {
      dummy.position.set(x, yOffset, z)
      dummy.updateMatrix()
      ref.current!.setMatrixAt(i, dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  }, [positions, dummy, yOffset])

  return (
    // renderOrder > 0 ensures fence draws after the floor (renderOrder 0).
    // depthTest={false} bypasses depth buffer comparison so the floor can
    // never occlude a fence tile regardless of floating-point precision.
    <instancedMesh ref={ref} args={[undefined, undefined, positions.length]} frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.1} depthTest={false} />
    </instancedMesh>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Fence() {
  const [railTex, postTex] = useTexture([
    '/floor map/2 Objects/2 Fence/1.png',
    '/floor map/2 Objects/2 Fence/7.png',
  ])

  useMemo(() => {
    for (const t of [railTex, postTex]) {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    }
  }, [railTex, postTex])

  return (
    <group>
      {/* Rail sections — sit at y=0.04, above vegetation (y=0.02) */}
      <FenceLayer
        positions={RAIL_POS}
        texture={railTex}
        width={RAIL_W}
        height={RAIL_H}
        yOffset={0.04}
        dummy={_railDummy}
      />
      {/* Posts — slightly higher so they render on top of rails */}
      <FenceLayer
        positions={POST_POS}
        texture={postTex}
        width={POST_W}
        height={POST_H}
        yOffset={0.05}
        dummy={_postDummy}
      />
    </group>
  )
}
