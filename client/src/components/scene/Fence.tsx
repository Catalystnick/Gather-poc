// Renders WORLD_FENCES from worldMap.ts using InstancedMesh — one mesh per
// unique fenceId so all instances of the same sprite share one draw call.
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
}

function FenceGroup({ fences, texture }: FenceGroupProps) {
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
      renderOrder={1}
    >
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.1} depthTest={false} />
    </instancedMesh>
  )
}

// ─── Fence ────────────────────────────────────────────────────────────────────

export default function Fence() {
  const textures = useTexture(TEXTURE_PATHS)
  const texArr = Array.isArray(textures) ? textures : [textures]

  useMemo(() => {
    for (const t of texArr) {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    }
  }, [texArr])

  // Group fences by fenceId — stable since WORLD_FENCES is a module-level constant.
  const grouped = useMemo(() => {
    const map = new Map<number, PlacedFence[]>()
    for (const f of WORLD_FENCES) {
      const arr = map.get(f.fenceId) ?? []
      arr.push(f)
      map.set(f.fenceId, arr)
    }
    return map
  }, [])

  return (
    <group>
      {USED_IDS.map((id, i) => {
        const fences = grouped.get(id)
        if (!fences?.length) return null
        return <FenceGroup key={id} fences={fences} texture={texArr[i]} />
      })}
    </group>
  )
}
