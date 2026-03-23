import { useRef, useMemo, useEffect } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

const TILE_SIZE = 1
const COLS = 50
const ROWS = 36

// Tile IDs corresponding to FieldsTile_XX.png
const DIRT  = 1   // clean cobblestone/dirt
const DIRTV = 9   // dirt with faint grass lines
const GRASS = 49  // solid green grass
const GRASSV = 25 // green grass variant

// Deterministic pseudo-random (no Math.random so map is stable across renders)
function hash(x: number, y: number): number {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function buildMap(): number[][] {
  return Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => {
      const v = hash(c, r)
      if (v < 0.15) return GRASS
      if (v < 0.25) return GRASSV
      if (v < 0.18) return DIRTV
      return DIRT
    })
  )
}

export const MAP = buildMap()
export const GRASS_IDS = new Set([GRASS, GRASSV])
const UNIQUE_IDS = [...new Set(MAP.flat())]

// Pre-compute per-tile-type positions once at module load.
// Each entry is [worldX, worldZ] for one instance of that tile type.
const offsetX = -(COLS * TILE_SIZE) / 2
const offsetZ = -(ROWS * TILE_SIZE) / 2

const TILE_GROUPS: Record<number, Array<[number, number]>> = {}
for (const id of UNIQUE_IDS) TILE_GROUPS[id] = []
MAP.forEach((row, r) =>
  row.forEach((id, c) => {
    TILE_GROUPS[id].push([
      offsetX + c * TILE_SIZE + TILE_SIZE / 2,
      offsetZ + r * TILE_SIZE + TILE_SIZE / 2,
    ])
  })
)

function tilePath(id: number): string {
  return `/floor map/1 Tiles/FieldsTile_${String(id).padStart(2, '0')}.png`
}

// Reusable dummy for matrix computation — never rendered.
const _dummy = new THREE.Object3D()
_dummy.rotation.x = -Math.PI / 2

interface TileLayerProps {
  positions: Array<[number, number]>
  texture: THREE.Texture
}

function TileLayer({ positions, texture }: TileLayerProps) {
  const ref = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    if (!ref.current) return
    positions.forEach(([x, z], i) => {
      _dummy.position.set(x, 0, z)
      _dummy.updateMatrix()
      ref.current!.setMatrixAt(i, _dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  }, [positions])

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, positions.length]} frustumCulled={false}>
      <planeGeometry args={[TILE_SIZE, TILE_SIZE]} />
      <meshBasicMaterial map={texture} />
    </instancedMesh>
  )
}

export default function FloorMap() {
  const textureUrls = useMemo(
    () => Object.fromEntries(UNIQUE_IDS.map(id => [String(id), tilePath(id)])),
    []
  )

  const textures = useTexture(textureUrls) as Record<string, THREE.Texture>

  useMemo(() => {
    Object.values(textures).forEach(t => {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
      t.wrapS = THREE.ClampToEdgeWrapping
      t.wrapT = THREE.ClampToEdgeWrapping
    })
  }, [textures])

  return (
    <group>
      {UNIQUE_IDS.map(id => (
        <TileLayer
          key={id}
          positions={TILE_GROUPS[id]}
          texture={textures[String(id)]}
        />
      ))}
    </group>
  )
}
