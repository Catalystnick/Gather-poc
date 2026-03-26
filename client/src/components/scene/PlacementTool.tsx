// Dev-only tool for designing the world map visually.
// Rendered only when import.meta.env.DEV is true (removed from prod builds).
//
// Tile workflow:
//   1. Adjust Tile ID, Col, Row, Width, Height in "Place Tiles" panel
//   2. Yellow ghost shows the exact stamp footprint
//   3. Click "Stamp" to write tiles into the atlas (instant, no reload)
//   4. Click "Export Map" → paste into src/data/worldMap.ts and commit
//
// Fence workflow:
//   1. Adjust Sprite (1–10), Col, Row, Direction in "Fences" panel
//   2. Orange ghost shows the placement tile
//   3. Click "Place Fence" → orange marker appears in the scene
//   4. "Undo" removes the last placed fence
//   5. "Copy Fences" copies WORLD_FENCES snippet to clipboard
//   6. "Export Map" includes WORLD_FENCES alongside tiles and zones

import * as THREE from 'three'
import { useControls, button } from 'leva'
import { useRef, useState, useEffect, useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import { COLS, ROWS, MAP, writeTile } from './FloorMap'
import type { PlacementHUDState } from './PlacementHUD'
import type { PlacedFence } from '../../data/worldMap'

const FENCE_PATHS = Array.from({ length: 10 }, (_, i) =>
  `/floor map/2 Objects/2 Fence/${i + 1}.png`
)

const TILE_SIZE = 1
const OX = -(COLS * TILE_SIZE) / 2
const OZ = -(ROWS * TILE_SIZE) / 2

const FENCE_STORAGE_KEY = 'gather_fence_draft'

interface Props {
  uvAttrRef: React.MutableRefObject<THREE.InstancedBufferAttribute | null>
  onHUDState: (state: PlacementHUDState) => void
}

// ─── Fence scene markers ──────────────────────────────────────────────────────

interface FenceMarkersProps {
  fences: PlacedFence[]
  ghostCol: number
  ghostRow: number
  ghostCols: number
  ghostRows: number
  ghostFenceId: number
  ghostDir: 'v' | 'h'
  ghostOffsetX: number
  ghostOffsetZ: number
}

// Rotation for a fence sprite lying flat on the XZ plane:
//   'v' = fence runs north-south (along Z) — matches existing Fence.tsx orientation
//   'h' = fence runs east-west (along X)
function fenceRot(dir: 'v' | 'h'): [number, number, number] {
  return dir === 'v' ? [-Math.PI / 2, Math.PI / 2, 0] : [-Math.PI / 2, 0, 0]
}

// Scale sprite to fit within one tile (1×1) while preserving aspect ratio.
// Equivalent to object-fit: contain — no stretching, no overflow.
function spriteSize(tex: THREE.Texture): [number, number] {
  const img = tex.image as HTMLImageElement
  const pw = img.naturalWidth  ?? img.width
  const ph = img.naturalHeight ?? img.height
  const aspect = pw / ph
  return aspect >= 1
    ? [TILE_SIZE, TILE_SIZE / aspect]   // wider than tall — fit to width
    : [TILE_SIZE * aspect, TILE_SIZE]   // taller than wide — fit to height
}

function FenceMarkers({ fences, ghostCol, ghostRow, ghostCols, ghostRows, ghostFenceId, ghostDir, ghostOffsetX, ghostOffsetZ }: FenceMarkersProps) {
  const textures = useTexture(FENCE_PATHS)

  useMemo(() => {
    for (const t of textures) {
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    }
  }, [textures])

  const tex = textures[ghostFenceId - 1]
  const rot = fenceRot(ghostDir)
  const [gw, gh] = spriteSize(tex)

  // Build ghost tile grid — one sprite per cell in the selected span
  const ghostSprites: [number, number][] = []
  for (let dr = 0; dr < ghostRows; dr++)
    for (let dc = 0; dc < ghostCols; dc++)
      ghostSprites.push([ghostCol + dc, ghostRow + dr])

  return (
    <>
      {/* Ghost — full span of sprites at correct pixel-proportional size, semi-transparent */}
      {ghostSprites.map(([c, r], i) => (
        <mesh key={i} position={[OX + c + ghostOffsetX, 0.015, OZ + r + ghostOffsetZ]} rotation={rot}>
          <planeGeometry args={[gw, gh]} />
          <meshBasicMaterial map={tex} transparent alphaTest={0.1} opacity={0.65} depthTest={false} />
        </mesh>
      ))}

      {/* Placed fences — actual sprites at correct pixel-proportional size, fully opaque */}
      {fences.map((f, i) => {
        const ftex = textures[f.fenceId - 1]
        const [fw, fh] = spriteSize(ftex)
        return (
          <mesh key={`p${i}`} position={[OX + f.col + f.offsetX, 0.012, OZ + f.row + f.offsetZ]} rotation={fenceRot(f.dir)}>
            <planeGeometry args={[fw, fh]} />
            <meshBasicMaterial map={ftex} transparent alphaTest={0.1} depthTest={false} />
          </mesh>
        )
      })}
    </>
  )
}

// ─── PlacementTool ────────────────────────────────────────────────────────────

export default function PlacementTool({ uvAttrRef, onHUDState }: Props) {
  // Fence state — initialised before useControls so button callbacks can close over the ref
  const fencesRef = useRef<PlacedFence[]>(
    JSON.parse(localStorage.getItem(FENCE_STORAGE_KEY) ?? '[]')
  )
  const [fences, setFences] = useState<PlacedFence[]>(fencesRef.current)

  function saveFences(next: PlacedFence[]) {
    fencesRef.current = next
    localStorage.setItem(FENCE_STORAGE_KEY, JSON.stringify(next))
    setFences([...next])
  }

  // ── Tile controls ──────────────────────────────────────────────────────────
  const { col, row, width, height } = useControls('Place Tiles', {
    tileId: { value: 49, min: 1, max: 64, step: 1, label: 'Tile ID (1–64)' },
    col:    { value: 0, min: 0, max: COLS - 1, step: 1, label: 'Col (left→right)' },
    row:    { value: 0, min: 0, max: ROWS - 1, step: 1, label: 'Row (top→bottom)' },
    width:  { value: 1, min: 1, max: 20, step: 1, label: 'Width' },
    height: { value: 1, min: 1, max: 20, step: 1, label: 'Height' },

    Stamp: button((get) => {
      const attr = uvAttrRef.current
      if (!attr) return
      const c  = get('Place Tiles.col')    as number
      const r  = get('Place Tiles.row')    as number
      const w  = get('Place Tiles.width')  as number
      const h  = get('Place Tiles.height') as number
      const id = get('Place Tiles.tileId') as number
      for (let dr = 0; dr < h; dr++)
        for (let dc = 0; dc < w; dc++)
          writeTile(c + dc, r + dr, id, attr)
    }),

    'Export Map': button((get) => {
      const zones = ['Dev', 'Design', 'Game'].map((label) => {
        const f = `Zone: ${label}`
        return {
          key:   label.toLowerCase(),
          x:     get(`${f}.x`)      as number,
          z:     get(`${f}.z`)      as number,
          width: get(`${f}.width`)  as number,
          depth: get(`${f}.height`) as number,
        }
      })
      const snippet =
        `// Auto-generated by PlacementTool — paste into src/data/worldMap.ts\n` +
        `export const WORLD_MAP = new Uint8Array([${Array.from(MAP).join(',')}])\n\n` +
        `export const WORLD_ZONES = ${JSON.stringify(zones, null, 2)}\n\n` +
        `export const WORLD_FENCES: PlacedFence[] = ${JSON.stringify(fencesRef.current, null, 2)}\n`
      navigator.clipboard?.writeText(snippet).catch(() => {})
      localStorage.removeItem('gather_map_draft')
    }),

    'Clear Draft': button(() => { localStorage.removeItem('gather_map_draft') }),
  })

  // ── Fence controls ─────────────────────────────────────────────────────────
  const { fenceId, fenceCol, fenceRow, fenceCols, fenceRows, fenceDir, fenceOffsetX, fenceOffsetZ } = useControls('Fences', {
    fenceId:      { value: 1,   min: 1, max: 10,       step: 1,   label: 'Sprite (1–10)' },
    fenceCol:     { value: 0,   min: 0, max: COLS - 1, step: 1,   label: 'Col' },
    fenceRow:     { value: 0,   min: 0, max: ROWS - 1, step: 1,   label: 'Row' },
    fenceCols:    { value: 1,   min: 1, max: 20,        step: 1,   label: 'Cols (span)' },
    fenceRows:    { value: 1,   min: 1, max: 20,        step: 1,   label: 'Rows (span)' },
    fenceDir:     { value: 'v', options: { Vertical: 'v', Horizontal: 'h' }, label: 'Direction' },
    fenceOffsetX: { value: 0.5, min: 0, max: 1,         step: 0.5, label: 'X edge (0=left, 0.5=center, 1=right)' },
    fenceOffsetZ: { value: 0.5, min: 0, max: 1,         step: 0.5, label: 'Z edge (0=top,  0.5=center, 1=bottom)' },

    'Place Fence': button((get) => {
      const id  = get('Fences.fenceId')      as number
      const c   = get('Fences.fenceCol')     as number
      const r   = get('Fences.fenceRow')     as number
      const cols = get('Fences.fenceCols')   as number
      const rows = get('Fences.fenceRows')   as number
      const dir = get('Fences.fenceDir')     as 'v' | 'h'
      const ox  = get('Fences.fenceOffsetX') as number
      const oz  = get('Fences.fenceOffsetZ') as number
      const batch: PlacedFence[] = []
      for (let dr = 0; dr < rows; dr++)
        for (let dc = 0; dc < cols; dc++)
          batch.push({ fenceId: id, col: c + dc, row: r + dr, dir, offsetX: ox, offsetZ: oz })
      saveFences([...fencesRef.current, ...batch])
    }),

    Undo: button((get) => {
      const cols = get('Fences.fenceCols') as number
      const rows = get('Fences.fenceRows') as number
      saveFences(fencesRef.current.slice(0, -(cols * rows)))
    }),

    'Clear Fences': button(() => {
      fencesRef.current = []
      localStorage.removeItem(FENCE_STORAGE_KEY)
      setFences([])
    }),

    'Copy Fences': button(() => {
      const snippet = `export const WORLD_FENCES = ${JSON.stringify(fencesRef.current, null, 2)}\n`
      navigator.clipboard?.writeText(snippet).catch(() => {})
    }),
  })

  // Notify parent so PlacementHUD (outside Canvas) can display current values
  useEffect(() => {
    onHUDState({ col, row, width, height, fenceId })
  }, [col, row, width, height, fenceId, onHUDState])

  const tileGhostX = OX + (col + width  / 2) * TILE_SIZE
  const tileGhostZ = OZ + (row  + height / 2) * TILE_SIZE

  return (
    <>
      {/* Tile ghost — yellow transparent plane */}
      <mesh position={[tileGhostX, 0.01, tileGhostZ]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width * TILE_SIZE, height * TILE_SIZE]} />
        <meshBasicMaterial color="yellow" transparent opacity={0.35} depthTest={false} />
      </mesh>

      <FenceMarkers
        fences={fences}
        ghostCol={fenceCol}
        ghostRow={fenceRow}
        ghostCols={fenceCols}
        ghostRows={fenceRows}
        ghostFenceId={fenceId}
        ghostDir={fenceDir as 'v' | 'h'}
        ghostOffsetX={fenceOffsetX}
        ghostOffsetZ={fenceOffsetZ}
      />
    </>
  )
}
