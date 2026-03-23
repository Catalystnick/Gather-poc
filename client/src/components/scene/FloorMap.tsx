import { useTexture } from '@react-three/drei'
import { useMemo } from 'react'
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
      if (v < 0.05) return GRASS
      if (v < 0.08) return GRASSV
      if (v < 0.18) return DIRTV
      return DIRT
    })
  )
}

const MAP = buildMap()
const UNIQUE_IDS = [...new Set(MAP.flat())]

function tilePath(id: number): string {
  return `/floor map/1 Tiles/FieldsTile_${String(id).padStart(2, '0')}.png`
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

  const offsetX = -(COLS * TILE_SIZE) / 2
  const offsetZ = -(ROWS * TILE_SIZE) / 2

  return (
    <group>
      {MAP.map((row, r) =>
        row.map((id, c) => (
          <mesh
            key={`${r}-${c}`}
            position={[
              offsetX + c * TILE_SIZE + TILE_SIZE / 2,
              0,
              offsetZ + r * TILE_SIZE + TILE_SIZE / 2,
            ]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[TILE_SIZE, TILE_SIZE]} />
            <meshBasicMaterial map={textures[String(id)]} />
          </mesh>
        ))
      )}
    </group>
  )
}
