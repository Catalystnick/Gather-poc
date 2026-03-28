// Grid coordinate utilities.
//
// Tile (col, row) origin: top-left of map. Col increases east, row increases south.
// Tile centre in world space: x = OX + col + 0.5,  z = OZ + row + 0.5
// where OX = OZ = -COLS/2 = -30 (COLS = ROWS = 60, TILE_SIZE = 1).
//
// These are the single source of truth for the tile↔world convention.
// Every system that converts between tile and world coords must go through here.

import { COLS, ROWS } from '../components/scene/FloorMap'

const TILE_SIZE = 1
const OX = -(COLS * TILE_SIZE) / 2  // -30
const OZ = -(ROWS * TILE_SIZE) / 2  // -30

export { COLS as GRID_COLS, ROWS as GRID_ROWS }

/** Convert integer tile coordinates to the Three.js world position of that tile's centre. */
export function tileToWorld(col: number, row: number): { x: number; z: number } {
  return {
    x: OX + col * TILE_SIZE + TILE_SIZE / 2,
    z: OZ + row * TILE_SIZE + TILE_SIZE / 2,
  }
}
