import { readFileSync } from 'node:fs'
import { simulateAuthoritativeStep } from './movementMath.js'

const GRID_COLS = 60
const GRID_ROWS = 60
const TILE_PX = 16
const WORLD_PX_MAX = GRID_COLS * TILE_PX - 0.001
const SIMULATION_HZ = 60
const SNAPSHOT_HZ = 20
const FIXED_DT_SECONDS = 1 / SIMULATION_HZ
const MOVE_SPEED_PX_PER_SECOND = TILE_PX * 4.6

const SPAWN_COL_MIN = 27
const SPAWN_COL_MAX = 33
const SPAWN_ROW_MIN = 27
const SPAWN_ROW_MAX = 33

const VALID_DIRECTIONS = new Set(['down', 'up', 'left', 'right'])

function toZoneKey(identifier) {
  return identifier
    .replace(/_?(zone|Zone)_?(trigger|Trigger)/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

function loadWorldData() {
  try {
    const url = new URL('../../client/public/hub.ldtk', import.meta.url)
    const raw = JSON.parse(readFileSync(url, 'utf8'))
    const level = raw?.levels?.[0]
    const layers = level?.layerInstances ?? []
    const collisionLayer = layers.find((layer) => layer.__identifier === 'Collision_grid')
    const collisionCsv = collisionLayer?.intGridCsv ?? []
    const gridWidth = collisionLayer?.__cWid ?? GRID_COLS
    const gridHeight = collisionLayer?.__cHei ?? GRID_ROWS

    const zones = layers
      .flatMap((layer) => layer.entityInstances ?? [])
      .filter((entity) => String(entity.__identifier || '').toLowerCase().includes('zone'))
      .map((entity) => ({
        key: toZoneKey(entity.__identifier),
        minX: entity.px[0] / TILE_PX,
        maxX: (entity.px[0] + entity.width) / TILE_PX - 1,
        minY: entity.px[1] / TILE_PX,
        maxY: (entity.px[1] + entity.height) / TILE_PX - 1,
      }))

    return {
      collisionCsv,
      gridWidth,
      gridHeight,
      zones,
    }
  } catch (error) {
    console.error('[world] failed to load hub.ldtk collision data:', error)
    return {
      collisionCsv: [],
      gridWidth: GRID_COLS,
      gridHeight: GRID_ROWS,
      zones: [],
    }
  }
}

function tileCenter(col, row) {
  return { x: col * TILE_PX + TILE_PX / 2, y: row * TILE_PX + TILE_PX / 2 }
}

function isValidAvatar(avatar) {
  return avatar && typeof avatar === 'object'
    && typeof avatar.shirt === 'string'
    && /^#[0-9A-Fa-f]{6}$/.test(avatar.shirt)
}

export function createWorldRuntime() {
  const worldData = loadWorldData()
  const players = {}
  let worldTick = 0

  function isValidTile(col, row) {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < GRID_COLS
      && row >= 0 && row < GRID_ROWS
  }

  function isWalkableTile(col, row) {
    if (!isValidTile(col, row)) return false
    const idx = row * worldData.gridWidth + col
    if (idx < 0 || idx >= worldData.collisionCsv.length) return false
    return worldData.collisionCsv[idx] === 0
  }

  function isValidDirection(direction) {
    return typeof direction === 'string' && VALID_DIRECTIONS.has(direction)
  }

  function canOccupyWorld(worldX, worldY) {
    const col = Math.floor(worldX / TILE_PX)
    const row = Math.floor(worldY / TILE_PX)
    return isWalkableTile(col, row)
  }

  function detectZoneKey(worldX, worldY) {
    const tileX = worldX / TILE_PX
    const tileY = worldY / TILE_PX
    for (const zone of worldData.zones) {
      if (
        tileX >= zone.minX && tileX <= zone.maxX
        && tileY >= zone.minY && tileY <= zone.maxY
      ) {
        return zone.key
      }
    }
    return null
  }

  function randomSpawn() {
    const candidates = []
    for (let row = SPAWN_ROW_MIN; row <= SPAWN_ROW_MAX; row += 1) {
      for (let col = SPAWN_COL_MIN; col <= SPAWN_COL_MAX; col += 1) {
        if (isWalkableTile(col, row)) candidates.push({ col, row })
      }
    }
    if (!candidates.length) return { col: 30, row: 30 }
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  function serializePlayerState(player) {
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      facing: player.facing,
      moving: player.moving,
      lastProcessedInputSeq: player.lastProcessedInputSeq ?? 0,
      zoneKey: player.zoneKey ?? null,
      muted: !!player.muted,
    }
  }

  function emitWorldSnapshot(io) {
    io.emit('world:snapshot', {
      serverTimeMs: Date.now(),
      tick: worldTick,
      players: Object.values(players).map(serializePlayerState),
    })
  }

  function simulatePlayer(player) {
    const input = player.inputState ?? {
      seq: player.lastProcessedInputSeq ?? 0,
      inputX: 0,
      inputY: 0,
      facing: player.facing,
      moving: false,
    }

    const next = simulateAuthoritativeStep({
      player,
      input,
      dtSeconds: FIXED_DT_SECONDS,
      speedPxPerSecond: MOVE_SPEED_PX_PER_SECOND,
      worldPxMax: WORLD_PX_MAX,
      canOccupyWorld,
      isValidDirection,
      detectZoneKey,
      tilePx: TILE_PX,
    })

    player.x = next.x
    player.y = next.y
    player.vx = next.vx
    player.vy = next.vy
    player.moving = next.moving
    player.facing = next.facing
    player.lastProcessedInputSeq = next.lastProcessedInputSeq
    player.col = next.col
    player.row = next.row
    player.zoneKey = next.zoneKey
  }

  function simulateTick() {
    worldTick += 1
    for (const player of Object.values(players)) {
      simulatePlayer(player)
    }
  }

  return {
    players,
    isValidAvatar,
    isValidDirection,
    isValidTile,
    tileCenter,
    detectZoneKey,
    randomSpawn,
    serializePlayerState,
    emitWorldSnapshot,
    simulateTick,
    simulationIntervalMs: Math.floor(1000 / SIMULATION_HZ),
    snapshotIntervalMs: Math.floor(1000 / SNAPSHOT_HZ),
  }
}
