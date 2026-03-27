// Edge-based tile walkability map derived from WORLD_FENCES.
//
// Rather than marking whole tiles as blocked, we record which tile *edges* have
// a fence on them. This correctly handles entrance gaps — tiles adjacent to a
// gap are reachable, but tiles behind an unbroken wall section are not.
//
// Edge key conventions:
//   Horizontal edge between row (r-1) and row r, at col c  →  "h:c:r"
//   Vertical   edge between col (c-1) and col c, at row r  →  "v:c:r"
//
// Fence offsetZ / offsetX mapping:
//   offsetZ === 0  →  top    edge of tile (col, row)  →  "h:col:row"
//   offsetZ === 1  →  bottom edge of tile (col, row)  →  "h:col:row+1"
//   offsetX === 0  →  left   edge of tile (col, row)  →  "v:col:row"
//   offsetX === 1  →  right  edge of tile (col, row)  →  "v:col+1:row"
//   offsetX/Z === 0.5  →  centre (visual only, no collision edge)
//
// Computed once at module load — zero runtime cost.

import { WORLD_FENCES } from '../data/worldMap'
import { GRID_COLS, GRID_ROWS } from './gridHelpers'
import type { Direction } from '../types'

const blockedEdges = new Set<string>()

for (const f of WORLD_FENCES) {
  if (f.offsetZ === 0)      blockedEdges.add(`h:${f.col}:${f.row}`)
  else if (f.offsetZ === 1) blockedEdges.add(`h:${f.col}:${f.row + 1}`)

  if (f.offsetX === 0)      blockedEdges.add(`v:${f.col}:${f.row}`)
  else if (f.offsetX === 1) blockedEdges.add(`v:${f.col + 1}:${f.row}`)
}

/**
 * Returns true if the player standing at (fromCol, fromRow) is allowed to
 * take one grid step in `direction`. Checks both map bounds and fence edges.
 */
export function canMove(fromCol: number, fromRow: number, direction: Direction): boolean {
  const toCol = fromCol + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0)
  const toRow = fromRow + (direction === 'down'  ? 1 : direction === 'up'   ? -1 : 0)

  if (toCol < 0 || toCol >= GRID_COLS || toRow < 0 || toRow >= GRID_ROWS) return false

  switch (direction) {
    case 'up':    return !blockedEdges.has(`h:${fromCol}:${fromRow}`)
    case 'down':  return !blockedEdges.has(`h:${fromCol}:${fromRow + 1}`)
    case 'left':  return !blockedEdges.has(`v:${fromCol}:${fromRow}`)
    case 'right': return !blockedEdges.has(`v:${fromCol + 1}:${fromRow}`)
  }
}
