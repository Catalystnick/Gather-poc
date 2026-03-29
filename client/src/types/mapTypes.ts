// LDtk JSON types + game-level derived types.

// ─── Raw LDtk JSON types ──────────────────────────────────────────────────────

export interface LdtkTile {
  /** Pixel position of the tile in the level [x, y]. Top-left origin. */
  px: [number, number]
  /** Pixel position of the source rect in the tileset image [x, y]. */
  src: [number, number]
  /** Flip flags: 0=none, 1=flipX, 2=flipY, 3=both. */
  f: number
  /** Tile ID in the tileset. */
  t: number
  d: number[]
  a: number
}

export interface LdtkEntityTileRect {
  tilesetUid: number
  x: number
  y: number
  w: number
  h: number
}

export interface LdtkFieldInstance {
  __identifier: string
  __value: unknown
  __type: string
}

export interface LdtkEntityInstance {
  __identifier: string
  __grid: [number, number]
  /** Entity pivot in normalized local space [0..1, 0..1]. */
  __pivot?: [number, number]
  __tags: string[]
  /** Visual tile for this entity, or null if purely logical (e.g. zone triggers). */
  __tile: LdtkEntityTileRect | null
  iid: string
  width: number
  height: number
  defUid: number
  /** Pixel position of entity pivot in the level. Default pivot (0,0) = top-left. */
  px: [number, number]
  fieldInstances: LdtkFieldInstance[]
}

export interface LdtkLayerInstance {
  __identifier: string
  __type: 'Tiles' | 'IntGrid' | 'Entities' | 'AutoLayer'
  __cWid: number
  __cHei: number
  __gridSize: number
  __tilesetRelPath: string | null
  __tilesetDefUid: number | null
  gridTiles: LdtkTile[]
  intGridCsv: number[]
  entityInstances: LdtkEntityInstance[]
}

export interface LdtkTilesetDef {
  uid: number
  identifier: string
  relPath: string | null
  pxWid: number
  pxHei: number
  tileGridSize: number
}

export interface LdtkLevel {
  identifier: string
  uid: number
  worldX: number
  worldY: number
  pxWid: number
  pxHei: number
  __bgColor: string
  layerInstances: LdtkLayerInstance[] | null
}

export interface LdtkProject {
  defs: {
    tilesets: LdtkTilesetDef[]
  }
  levels: LdtkLevel[]
}

// ─── Game-level derived types ─────────────────────────────────────────────────

/** A rectangular voice zone in world space. World Y increases northward. */
export interface Zone {
  key: string
  minX: number
  maxX: number
  /** South edge in world Y (lower value). */
  minY: number
  /** North edge in world Y (higher value). */
  maxY: number
}

/** Fully parsed map data consumed by World and hooks. */
export interface LdtkMapData {
  level: LdtkLevel
  tilesetDefs: Map<number, LdtkTilesetDef>
  /** Flat IntGrid CSV, row-major order. 1 = blocked, 0 = walkable. */
  collisionCsv: number[]
  gridWidth: number
  gridHeight: number
  zones: Zone[]
  /** Walkable tile candidates near the statue for spawn randomisation. */
  spawnCandidates: Array<{ col: number; row: number }>
}
