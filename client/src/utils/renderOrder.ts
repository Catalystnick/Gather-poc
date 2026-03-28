// Y-sort render order for sprites in an orthographic top-down scene.
// World Z ranges from –30 to +30 for a 60×60 map (TILE_SIZE = 1).

const SPRITE_BASE  = 5000
const SPRITE_SCALE = 100 // 1 world-Z unit → 100 sort slots

/**
 * Render order for a sprite or tile-object whose south (feet) edge is at
 * `worldZ`. Objects with a larger Z (further south) render on top.
 */
export function spriteOrder(worldZ: number): number {
  return Math.round(SPRITE_BASE + worldZ * SPRITE_SCALE)
}
