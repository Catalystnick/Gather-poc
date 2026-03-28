// Tile walkability — checked every time the player attempts a grid step.
//
// Collision tiles are derived from the TMX "Object and house collisions"
// objectgroup — the authoritative source placed by the map designer.
// Movement INTO a blocked tile is refused in all four directions.
//
// Computed once at module load — zero runtime cost per frame.

import { WORLD_FENCE_TILES } from '../data/worldMap'
import { GRID_COLS, GRID_ROWS } from './gridHelpers'
import type { Direction } from '../types'

const blockedTiles = new Set<string>(
  WORLD_FENCE_TILES.map(({ col, row }) => `${col}:${row}`),
)

/**
 * Returns true if the player standing at (fromCol, fromRow) is allowed to
 * take one grid step in `direction`. Checks map bounds and solid tiles.
 */
export function canMove(fromCol: number, fromRow: number, direction: Direction): boolean {
  const toCol = fromCol + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0)
  const toRow = fromRow + (direction === 'down'  ? 1 : direction === 'up'   ? -1 : 0)

  if (toCol < 0 || toCol >= GRID_COLS || toRow < 0 || toRow >= GRID_ROWS) return false

  return !blockedTiles.has(`${toCol}:${toRow}`)
}
