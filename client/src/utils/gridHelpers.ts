// Grid coordinate helpers — 1 unit = 1 tile.
// Voice proximity ranges (CONNECT_RANGE=7, DISCONNECT_RANGE=9) are in tile units,
// so keeping the coordinate system 1:1 with the grid means no scaling needed.


/** Convert tile grid position to world-space point used for distance calculations. */
export function tileToWorld(col: number, row: number): { x: number; y: number } {
  return { x: col, y: row };
}
