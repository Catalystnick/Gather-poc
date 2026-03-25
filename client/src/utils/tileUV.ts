export interface TileUV {
  offsetU: number
  offsetV: number
}

// Returns the UV offset to sample one tile from a grid atlas.
// tileId is 1-based (tile 1 = top-left of atlas).
// Three.js UV origin is bottom-left, so V is flipped relative to image rows.
export function tileUV(tileId: number, cols: number, rows: number): TileUV {
  const localId = tileId - 1
  const col = localId % cols
  const row = Math.floor(localId / cols)
  return {
    offsetU: col / cols,
    offsetV: 1 - (row + 1) / rows,
  }
}
