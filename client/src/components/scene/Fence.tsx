// Renders WORLD_FENCES from worldMap.ts using InstancedMesh — one mesh per
// unique (fenceId, worldZ) bucket so all instances at the same depth share
// one draw call AND each bucket gets its own renderOrder for Y-sorting.
//
// Position formula (matches PlacementTool):
//   world_x = OX + col + offsetX
//   world_z = OZ + row + offsetZ
//   OX = OZ = -(60 / 2) = -30

import { useRef, useMemo, useEffect } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

import { COLS, ROWS } from './FloorMap'
import { WORLD_FENCES } from '../../data/worldMap'
import type { PlacedFence } from '../../data/worldMap'

const TILE_SIZE = 1
const OX = -(COLS * TILE_SIZE) / 2
const OZ = -(ROWS * TILE_SIZE) / 2

// Only load textures for IDs actually present in WORLD_FENCES.
const USED_IDS = [...new Set(WORLD_FENCES.map(f => f.fenceId))].sort((a, b) => a - b)
const TEXTURE_PATHS = USED_IDS.map(id => `/floor map/2 Objects/2 Fence/${id}.png`)

console.log('[Fence] WORLD_FENCES count:', WORLD_FENCES.length)
console.log('[Fence] USED_IDS:', USED_IDS)
console.log('[Fence] TEXTURE_PATHS:', TEXTURE_PATHS)

// renderOrder scale: 1 world unit → 100 sort units, giving sub-tile precision.
const RENDER_SCALE = 100

// Scale sprite to fit within one tile while preserving aspect ratio.
function spriteSize(tex: THREE.Texture): [number, number] {
  const img = tex.image as HTMLImageElement
  const pw = img.naturalWidth ?? img.width
  const ph = img.naturalHeight ?? img.height
  const aspect = pw / ph
  return aspect >= 1
    ? [TILE_SIZE, TILE_SIZE / aspect]
    : [TILE_SIZE * aspect, TILE_SIZE]
}

// ─── FenceGroup ───────────────────────────────────────────────────────────────
// One InstancedMesh for all placements of a single fenceId.

interface FenceGroupProps {
  fences: PlacedFence[]
  texture: THREE.Texture
  renderOrder: number
}

function FenceGroup({ fences, texture, renderOrder }: FenceGroupProps) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const [w, h] = spriteSize(texture)

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    fences.forEach((f, i) => {
      dummy.position.set(OX + f.col + f.offsetX, 0.012, OZ + f.row + f.offsetZ)
      dummy.rotation.set(-Math.PI / 2, f.dir === 'v' ? Math.PI / 2 : 0, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [fences, dummy])

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, fences.length]}
      frustumCulled={false}
      renderOrder={renderOrder}
    >
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.1} depthTest={false} depthWrite={false} />
    </instancedMesh>
  )
}

// ─── Fence ────────────────────────────────────────────────────────────────────

export default function Fence() {
  console.log('[Fence] component mounting, loading textures:', TEXTURE_PATHS)
  const textures = useTexture(
    TEXTURE_PATHS,
    (loaded) => {
      const arr = Array.isArray(loaded) ? loaded : [loaded]
      console.log('[Fence] textures loaded OK:', arr.map((t, i) => `${TEXTURE_PATHS[i]} → ${t.image?.width}×${t.image?.height}`))
    },
    (err) => {
      console.error('[Fence] texture load FAILED:', err)
    },
  )
  const texArr = Array.isArray(textures) ? textures : [textures]

  useMemo(() => {
    for (const t of texArr) {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    }
  }, [texArr])

  // Map fenceId → texture for O(1) lookup.
  const texByFenceId = useMemo(() => {
    const m = new Map<number, THREE.Texture>()
    USED_IDS.forEach((id, i) => m.set(id, texArr[i]))
    return m
  }, [texArr])

  // Group by (fenceId, worldZ bucket) so each unique depth level gets its own
  // InstancedMesh with the correct renderOrder for Y-sorting.
  const grouped = useMemo(() => {
    const map = new Map<string, { fenceId: number; fences: PlacedFence[]; renderOrder: number }>()
    for (const f of WORLD_FENCES) {
      const worldZ = OZ + f.row + f.offsetZ
      const zKey = Math.round(worldZ * RENDER_SCALE)
      const key = `${f.fenceId}_${zKey}`
      if (!map.has(key)) map.set(key, { fenceId: f.fenceId, fences: [], renderOrder: zKey })
      map.get(key)!.fences.push(f)
    }
    return map
  }, [])

  console.log('[Fence] grouped buckets:', grouped.size, '| fenceIds in map:', [...texByFenceId.keys()])

  return (
    <group>
      {Array.from(grouped.entries()).map(([key, { fenceId, fences, renderOrder }]) => {
        const tex = texByFenceId.get(fenceId)
        if (!tex) {
          console.warn('[Fence] no texture for fenceId', fenceId, '— skipping group', key)
          return null
        }
        return <FenceGroup key={key} fences={fences} texture={tex} renderOrder={renderOrder} />
      })}
    </group>
  )
}
