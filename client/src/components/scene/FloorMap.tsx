import { useRef, useMemo, useEffect } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { WORLD_MAP } from '../../data/worldMap'
import { tileUV } from '../../utils/tileUV'

export const COLS = 60
export const ROWS = 60
const TILE_SIZE = 1
const ATLAS_COLS = 8
const ATLAS_ROWS = 8
const TILE_COUNT = ATLAS_COLS * ATLAS_ROWS  // 64
const TILE_PX    = 32                        // each tile is 32×32 px
const ATLAS_PX   = TILE_PX * ATLAS_COLS     // atlas canvas = 256×256
const TOTAL = COLS * ROWS
const REPEAT = (1 / ATLAS_COLS).toFixed(8)

function tilePath(id: number) {
  return `/floor map/1 Tiles/FieldsTile_${String(id).padStart(2, '0')}.png`
}

// Build URL map for all 64 tiles (keys: "t1"…"t64")
const TILE_URLS: Record<string, string> = {}
for (let i = 1; i <= TILE_COUNT; i++) TILE_URLS[`t${i}`] = tilePath(i)

const DIRT  = 1
const DIRTV = 9
const GRASS  = 49
const GRASSV = 25

export const GRASS_IDS = new Set([GRASS, GRASSV])

// ─── MAP — flat Uint8Array, row-major: index = row * COLS + col ───────────────
// Load priority: worldMap.ts (permanent) → localStorage draft → procedural hash

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function fillProcedural(out: Uint8Array) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = hash(c, r)
      let id: number
      if (v < 0.15)      id = GRASS
      else if (v < 0.25) id = GRASSV
      else if (v < 0.28) id = DIRTV
      else               id = DIRT
      out[r * COLS + c] = id
    }
  }
}

export const MAP = new Uint8Array(TOTAL)

if (WORLD_MAP) {
  MAP.set(WORLD_MAP)
} else {
  const draft = typeof window !== 'undefined'
    ? localStorage.getItem('gather_map_draft')
    : null
  if (draft) {
    try {
      const data = JSON.parse(draft) as number[]
      if (data.length === TOTAL) {
        data.forEach((id, i) => { MAP[i] = id })
      } else {
        fillProcedural(MAP)
      }
    } catch {
      fillProcedural(MAP)
    }
  } else {
    fillProcedural(MAP)
  }
}

// ─── World positions (constant — never moves) ─────────────────────────────────
const OX = -(COLS * TILE_SIZE) / 2
const OZ = -(ROWS * TILE_SIZE) / 2

const POSITIONS = new Float32Array(TOTAL * 2)
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c
    POSITIONS[i * 2]     = OX + c * TILE_SIZE + TILE_SIZE / 2
    POSITIONS[i * 2 + 1] = OZ + r * TILE_SIZE + TILE_SIZE / 2
  }
}

// ─── UV buffer — two floats per tile: [offsetU, offsetV] ─────────────────────
function buildUVArray(): Float32Array {
  const uvs = new Float32Array(TOTAL * 2)
  for (let i = 0; i < TOTAL; i++) {
    const { offsetU, offsetV } = tileUV(MAP[i], ATLAS_COLS, ATLAS_ROWS)
    uvs[i * 2]     = offsetU
    uvs[i * 2 + 1] = offsetV
  }
  return uvs
}

// ─── Tile mutation — call to change any tile at runtime ───────────────────────
// Also auto-saves a draft to localStorage so work survives page reloads.
export function writeTile(
  col: number,
  row: number,
  tileId: number,
  uvAttr: THREE.InstancedBufferAttribute,
) {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return
  const i = row * COLS + col
  MAP[i] = tileId
  const { offsetU, offsetV } = tileUV(tileId, ATLAS_COLS, ATLAS_ROWS)
  ;(uvAttr.array as Float32Array)[i * 2]     = offsetU
  ;(uvAttr.array as Float32Array)[i * 2 + 1] = offsetV
  uvAttr.needsUpdate = true
  if (typeof window !== 'undefined') {
    localStorage.setItem('gather_map_draft', JSON.stringify(Array.from(MAP)))
  }
}

// ─── Shader ───────────────────────────────────────────────────────────────────
// instanceMatrix is injected automatically by Three.js for InstancedMesh.
// uvOffset is a per-instance vec2 storing the atlas tile's UV origin.
const VERT = /* glsl */`
  attribute vec2 uvOffset;
  varying vec2 vUv;

  void main() {
    // Derive UV from position — avoids depending on USE_UV being defined
    // for ShaderMaterial. PlaneGeometry [1,1] has vertices at ±0.5 in XY,
    // so position.xy + 0.5 maps to [0..1] UV space.
    vec2 tileUV = position.xy + vec2(0.5);
    vUv = tileUV * vec2(${REPEAT}, ${REPEAT}) + uvOffset;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAG = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(map, vUv);
  }
`

const _dummy = new THREE.Object3D()
_dummy.rotation.x = -Math.PI / 2

// ─── Component ───────────────────────────────────────────────────────────────
interface FloorMapProps {
  uvAttrRef: React.MutableRefObject<THREE.InstancedBufferAttribute | null>
}

export default function FloorMap({ uvAttrRef }: FloorMapProps) {
  const tiles = useTexture(TILE_URLS) as Record<string, THREE.Texture>
  const meshRef = useRef<THREE.InstancedMesh>(null)

  // Composite all 64 individual tile PNGs into one CanvasTexture at startup.
  // Tile IDs 1–64 are placed left-to-right, top-to-bottom in the atlas grid.
  // This runs once when the tiles finish loading (Suspense ensures they're ready).
  const atlas = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width  = ATLAS_PX
    canvas.height = ATLAS_PX
    const ctx = canvas.getContext('2d')!
    for (let id = 1; id <= TILE_COUNT; id++) {
      const col = (id - 1) % ATLAS_COLS
      const row = Math.floor((id - 1) / ATLAS_COLS)
      ctx.drawImage(tiles[`t${id}`].image as HTMLImageElement, col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX)
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter  = THREE.NearestFilter
    return tex
  }, [tiles])

  const material = useMemo(
    () => new THREE.ShaderMaterial({
      uniforms: { map: { value: atlas } },
      vertexShader: VERT,
      fragmentShader: FRAG,
    }),
    [atlas],
  )

  // Write instance matrices once — positions never change.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    for (let i = 0; i < TOTAL; i++) {
      _dummy.position.set(POSITIONS[i * 2], 0, POSITIONS[i * 2 + 1])
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }, [])

  // Write per-instance UV offsets and expose the attribute ref.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const attr = new THREE.InstancedBufferAttribute(buildUVArray(), 2)
    mesh.geometry.setAttribute('uvOffset', attr)
    uvAttrRef.current = attr
  }, [uvAttrRef])

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, TOTAL]}
      material={material}
      frustumCulled={false}
    >
      <planeGeometry args={[TILE_SIZE, TILE_SIZE]} />
    </instancedMesh>
  )
}
