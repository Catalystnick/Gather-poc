// Dev-only overlays for PlacementTool.
// Lives outside the Canvas so normal fixed CSS positioning works.

import { COLS, ROWS } from './FloorMap'

const OX = -(COLS / 2)
const OZ = -(ROWS / 2)

// ─── Tile coordinate display ─────────────────────────────────────────────────
// Shows the top-left tile's world position alongside col/row and stamp size.

interface TileCoordProps {
  col: number
  row: number
  width: number
  height: number
}

function TileCoordOverlay({ col, row, width, height }: TileCoordProps) {
  const wx = (OX + col).toFixed(1)
  const wz = (OZ + row).toFixed(1)

  return (
    <div style={{
      position: 'fixed', bottom: 8, left: 8, zIndex: 9999,
      background: 'rgba(0,0,0,0.78)', color: '#facc15',
      fontFamily: 'monospace', fontSize: 12,
      padding: '6px 10px', borderRadius: 6,
      pointerEvents: 'none', lineHeight: 1.7,
    }}>
      <div style={{ color: '#888', fontSize: 10, marginBottom: 2 }}>PLACE TILES</div>
      <div>Col {col} · Row {row}</div>
      <div>W {width} · H {height}</div>
      <div>World ({wx}, {wz})</div>
    </div>
  )
}

// ─── Fence sprite preview ─────────────────────────────────────────────────────
// Shows the selected fence PNG so you know what you're placing.
// Positioned to the left of the Leva panel (Leva sits at right: 0, ~280px wide).

interface FencePreviewProps {
  fenceId: number
}

function FencePreviewOverlay({ fenceId }: FencePreviewProps) {
  return (
    <div style={{
      position: 'fixed', top: 8, right: 288, zIndex: 9999,
      background: 'rgba(0,0,0,0.82)',
      padding: '8px 12px', borderRadius: 6,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      pointerEvents: 'none',
    }}>
      <div style={{ color: '#fb923c', fontFamily: 'monospace', fontSize: 11 }}>
        FENCE #{fenceId}
      </div>
      <img
        src={`/floor-map/2-Objects/2-Fence/${fenceId}.png`}
        style={{ imageRendering: 'pixelated', maxWidth: 80, maxHeight: 80 }}
        alt={`fence sprite ${fenceId}`}
      />
    </div>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface PlacementHUDState {
  col: number
  row: number
  width: number
  height: number
  fenceId: number
}

export default function PlacementHUD({ col, row, width, height, fenceId }: PlacementHUDState) {
  return (
    <>
      <TileCoordOverlay col={col} row={row} width={width} height={height} />
      <FencePreviewOverlay fenceId={fenceId} />
    </>
  )
}
