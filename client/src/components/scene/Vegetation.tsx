import { useTexture } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { MAP, GRASS_IDS } from '../scene/FloorMap'

// Must match FloorMap constants
const TILE_SIZE = 1
const MAP_COLS = 50
const MAP_ROWS = 36

// 32 px = 1 world unit (same scale as tiles).
// Objects are upscaled 1.8× so they read well from above.
const PX = (px: number) => (px / 32) * 1.8

interface VegDef {
  key: string
  src: string
  w: number  // world units
  h: number
}

const DEFS: VegDef[] = [
  // Bushes (6 variants)
  { key: 'b1', src: '/floor map/2 Objects/9 Bush/1.png', w: PX(26), h: PX(23) },
  { key: 'b2', src: '/floor map/2 Objects/9 Bush/2.png', w: PX(37), h: PX(26) },
  { key: 'b3', src: '/floor map/2 Objects/9 Bush/3.png', w: PX(33), h: PX(22) },
  { key: 'b4', src: '/floor map/2 Objects/9 Bush/4.png', w: PX(39), h: PX(25) },
  { key: 'b5', src: '/floor map/2 Objects/9 Bush/5.png', w: PX(41), h: PX(25) },
  { key: 'b6', src: '/floor map/2 Objects/9 Bush/6.png', w: PX(40), h: PX(26) },
  // Grass tufts (6 variants) — scaled 3× to be visible from top-down
  { key: 'g1', src: '/floor map/2 Objects/5 Grass/1.png', w: PX(5)  * 2, h: PX(6)  * 2 },
  { key: 'g2', src: '/floor map/2 Objects/5 Grass/2.png', w: PX(9)  * 2, h: PX(6)  * 2 },
  { key: 'g3', src: '/floor map/2 Objects/5 Grass/3.png', w: PX(5)  * 2, h: PX(7)  * 2 },
  { key: 'g4', src: '/floor map/2 Objects/5 Grass/4.png', w: PX(8)  * 2, h: PX(5)  * 2 },
  { key: 'g5', src: '/floor map/2 Objects/5 Grass/5.png', w: PX(6)  * 2, h: PX(10) * 2 },
  { key: 'g6', src: '/floor map/2 Objects/5 Grass/6.png', w: PX(5)  * 2, h: PX(8)  * 2 },
  // Flowers (12 variants)
  { key: 'f1',  src: '/floor map/2 Objects/6 Flower/1.png',  w: PX(6), h: PX(6) },
  { key: 'f2',  src: '/floor map/2 Objects/6 Flower/2.png',  w: PX(6), h: PX(5) },
  { key: 'f3',  src: '/floor map/2 Objects/6 Flower/3.png',  w: PX(5), h: PX(5) },
  { key: 'f4',  src: '/floor map/2 Objects/6 Flower/4.png',  w: PX(6), h: PX(5) },
  { key: 'f5',  src: '/floor map/2 Objects/6 Flower/5.png',  w: PX(6), h: PX(4) },
  { key: 'f6',  src: '/floor map/2 Objects/6 Flower/6.png',  w: PX(6), h: PX(5) },
  { key: 'f7',  src: '/floor map/2 Objects/6 Flower/7.png',  w: PX(8), h: PX(6) },
  { key: 'f8',  src: '/floor map/2 Objects/6 Flower/8.png',  w: PX(7), h: PX(6) },
  { key: 'f9',  src: '/floor map/2 Objects/6 Flower/9.png',  w: PX(8), h: PX(7) },
  { key: 'f10', src: '/floor map/2 Objects/6 Flower/10.png', w: PX(6), h: PX(4) },
  { key: 'f11', src: '/floor map/2 Objects/6 Flower/11.png', w: PX(6), h: PX(5) },
  { key: 'f12', src: '/floor map/2 Objects/6 Flower/12.png', w: PX(8), h: PX(7) },
]

const BUSH_KEYS   = DEFS.filter(d => d.key.startsWith('b')).map(d => d.key)
const GRASS_KEYS  = DEFS.filter(d => d.key.startsWith('g')).map(d => d.key)
const FLOWER_KEYS = DEFS.filter(d => d.key.startsWith('f')).map(d => d.key)
const DEF_BY_KEY  = Object.fromEntries(DEFS.map(d => [d.key, d]))

function hash(x: number, y: number, s: number): number {
  const n = Math.sin(x * 73.1 + y * 197.3 + s * 439.7) * 43758.5453
  return n - Math.floor(n)
}

function pick<T>(arr: T[], x: number, y: number, s: number): T {
  return arr[Math.floor(hash(x, y, s) * arr.length)]
}

interface VegItem {
  id: string
  defKey: string
  x: number
  z: number
}

function buildVegetation(): VegItem[] {
  const items: VegItem[] = []
  const halfX = (MAP_COLS * TILE_SIZE) / 2
  const halfZ = (MAP_ROWS * TILE_SIZE) / 2

  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const v = hash(c, r, 42)

      // Base tile-centre world coords
      const cx = -halfX + c * TILE_SIZE + TILE_SIZE / 2
      const cz = -halfZ + r * TILE_SIZE + TILE_SIZE / 2

      // Keep a clear radius around spawn (0, 0)
      if (cx * cx + cz * cz < 9) continue

      // Jitter within the tile
      const jx = (hash(c, r, 11) - 0.5) * 0.7
      const jz = (hash(c, r, 22) - 0.5) * 0.7

      const isGrassTile = GRASS_IDS.has(MAP[r][c])

      if (v < 0.03) {
        // Bush — sparse
        items.push({ id: `b-${r}-${c}`, defKey: pick(BUSH_KEYS, c, r, 99), x: cx + jx, z: cz + jz })
      } else if (v < 0.30 && isGrassTile) {
        // Grass tuft — only on grass-coloured floor tiles
        items.push({ id: `g-${r}-${c}`, defKey: pick(GRASS_KEYS, c, r, 77), x: cx + jx, z: cz + jz })
      } else if (v < 0.14) {
        // Flower
        items.push({ id: `f-${r}-${c}`, defKey: pick(FLOWER_KEYS, c, r, 55), x: cx + jx, z: cz + jz })
      }
    }
  }
  return items
}

const VEG_ITEMS = buildVegetation()

export default function Vegetation() {
  const textureUrls = useMemo(
    () => Object.fromEntries(DEFS.map(d => [d.key, d.src])),
    []
  )

  const textures = useTexture(textureUrls) as Record<string, THREE.Texture>

  useMemo(() => {
    Object.values(textures).forEach(t => {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    })
  }, [textures])

  return (
    <group>
      {VEG_ITEMS.map(item => {
        const def = DEF_BY_KEY[item.defKey]
        return (
          <mesh
            key={item.id}
            position={[item.x, 0.02, item.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[def.w, def.h]} />
            <meshBasicMaterial
              map={textures[item.defKey]}
              transparent
              alphaTest={0.1}
            />
          </mesh>
        )
      })}
    </group>
  )
}
