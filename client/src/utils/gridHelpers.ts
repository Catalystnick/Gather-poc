// Grid coordinate utilities.
//
// Tile (col, row) origin: top-left of map. Col increases east, row increases south.
// Tile centre in world space: x = OX + col + 0.5,  z = OZ + row + 0.5
// where OX = OZ = -COLS/2 = -30 (COLS = ROWS = 60, TILE_SIZE = 1).
//
// These are the single source of truth for the tile↔world convention.
// Every system that converts between tile and world coords must go through here.

import { COLS, ROWS } from '../components/scene/FloorMap'
import type { Direction } from '../types'

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

/**
 * Convert any world position to the integer tile it falls in.
 * Used only once at spawn — never called during movement.
 */
export function worldToTile(x: number, z: number): { col: number; row: number } {
  return {
    col: Math.floor((x - OX) / TILE_SIZE),
    row: Math.floor((z - OZ) / TILE_SIZE),
  }
}

/** Map a facing direction to its (dcol, drow) unit step. */
export function directionToOffset(direction: Direction): { dc: number; dr: number } {
  switch (direction) {
    case 'up':    return { dc:  0, dr: -1 }
    case 'down':  return { dc:  0, dr:  1 }
    case 'left':  return { dc: -1, dr:  0 }
    case 'right': return { dc:  1, dr:  0 }
  }
}
