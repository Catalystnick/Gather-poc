import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { AccessToken } from 'livekit-server-sdk'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { readFileSync } from 'node:fs'
import { requireAuth, requireAuthSocket } from './middleware/requireAuth.js'
import { TeleportRequestsStore } from './chat/teleportRequestsStore.js'
import { createChatRateLimiter } from './chat/chatRateLimiter.js'
import { normalizeInput, simulateAuthoritativeStep } from './world/movementMath.js'
import {
  handleTagSend,
  handleTeleportRequest,
  handleTeleportRespond,
} from './chat/commandRouter.js'

const app = express()

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : null

app.use(cors({
  origin: allowedOrigins ?? '*',
}))
app.use(express.json())

// Per authenticated user (not just IP) so NAT / mobile gateways don't share one bucket.
// Proximity + zone join + brief 403/429 retries need headroom; zone prefetch was removed client-side.
const tokenLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) =>
    (req.user?.sub ? `lk:${req.user.sub}` : ipKeyGenerator(req.ip)),
})

// LiveKit token endpoint — requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
const LIVEKIT_URL = process.env.LIVEKIT_URL
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || ''
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || ''

// Zone keys — must be kept in sync with WORLD_ZONES keys in client/src/data/worldMap.ts.
// Any change here requires a coordinated client + server deploy.
const ZONE_KEYS = ['dev', 'design', 'game']
const ALLOWED_ROOMS = new Set([
  'gather-world',
  ...ZONE_KEYS.map(zoneKey => `gather-world-zone-${zoneKey}`),
])

if (!LIVEKIT_URL) {
  console.error('[livekit] LIVEKIT_URL is not set. Voice will not function.')
}

app.post('/livekit/token', requireAuth, tokenLimiter, async (req, res) => {
  const { roomName, identity, name, intent } = req.body || {}
  if (!identity || typeof identity !== 'string') {
    return res.status(400).json({ error: 'identity required' })
  }
  if (!ALLOWED_ROOMS.has(roomName)) {
    return res.status(400).json({ error: 'invalid room' })
  }
  const authedUserId = req.user?.sub
  if (!authedUserId || authedUserId !== identity) {
    return res.status(403).json({ error: 'identity mismatch' })
  }
  const tokenIntent = intent === 'prefetch' ? 'prefetch' : 'join'
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit not configured' })
  }
  try {
    const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: tokenIntent === 'prefetch' ? '30s' : '2h',
      name: name || identity,
    })
    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: tokenIntent === 'join',
      canSubscribe: tokenIntent === 'join',
      canUpdateOwnMetadata: tokenIntent === 'join',
    })
    const token = await accessToken.toJwt()
    res.json({ token, url: LIVEKIT_URL })
  } catch (err) {
    console.error('[livekit] token error:', err)
    res.status(500).json({ error: 'Failed to create token' })
  }
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins ?? '*' },
})

const GRID_COLS = 60
const GRID_ROWS = 60
const TILE_PX = 16
const WORLD_PX_MAX = GRID_COLS * TILE_PX - 0.001
const SIMULATION_HZ = 60
const SNAPSHOT_HZ = 20
const FIXED_DT_SECONDS = 1 / SIMULATION_HZ
const MOVE_SPEED_PX_PER_SECOND = TILE_PX * 4.6

// Spawn in the open central area, clear of all zone fences.
// Cols 27–33, rows 27–33 map to the world centre with no fences.
const SPAWN_COL_MIN = 27
const SPAWN_COL_MAX = 33
const SPAWN_ROW_MIN = 27
const SPAWN_ROW_MAX = 33

const CHAT_BURST_TOKENS = 1
const CHAT_REFILL_PER_SECOND = 1

const VALID_DIRECTIONS = new Set(['down', 'up', 'left', 'right'])
const teleportRequests = new TeleportRequestsStore({ cooldownMs: 30_000 })
const chatRateLimiter = createChatRateLimiter({
  burstTokens: CHAT_BURST_TOKENS,
  refillPerSecond: CHAT_REFILL_PER_SECOND,
})
const players = {}
let worldTick = 0

function tileCenter(col, row) {
  return { x: col * TILE_PX + TILE_PX / 2, y: row * TILE_PX + TILE_PX / 2 }
}

function looksLikeReservedCommand(text) {
  const lower = text.toLowerCase()
  return lower === '@tag'
    || lower.startsWith('@tag ')
    || lower === '/teleport'
    || lower.startsWith('/teleport ')
}

function sanitizeTokenName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '')
}

function tokenForPlayerName(name) {
  const safe = sanitizeTokenName(name)
  return `@${safe || 'user'}`
}

function toZoneKey(identifier) {
  return identifier
    .replace(/_?(zone|Zone)_?(trigger|Trigger)/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

function loadWorldData() {
  try {
    const url = new URL('../client/public/hub.ldtk', import.meta.url)
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

const worldData = loadWorldData()

function isValidAvatar(avatar) {
  return avatar && typeof avatar === 'object'
    && typeof avatar.shirt === 'string'
    && /^#[0-9A-Fa-f]{6}$/.test(avatar.shirt)
}

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
  for (let row = SPAWN_ROW_MIN; row <= SPAWN_ROW_MAX; row++) {
    for (let col = SPAWN_COL_MIN; col <= SPAWN_COL_MAX; col++) {
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

function normalizeChatMentions(rawMentions) {
  if (!Array.isArray(rawMentions)) return []
  const mentions = []
  const seenUserIds = new Set()
  for (const rawMention of rawMentions) {
    if (!rawMention || typeof rawMention !== 'object') continue
    const userId = typeof rawMention.userId === 'string' ? rawMention.userId.trim() : ''
    if (!userId || seenUserIds.has(userId)) continue
    const mentionedPlayer = players[userId]
    if (!mentionedPlayer) continue
    mentions.push({
      userId,
      token: tokenForPlayerName(mentionedPlayer.name),
    })
    seenUserIds.add(userId)
    if (mentions.length >= 16) break
  }
  return mentions
}

function emitWorldSnapshot() {
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

setInterval(() => {
  worldTick += 1
  for (const player of Object.values(players)) {
    simulatePlayer(player)
  }
}, Math.floor(1000 / SIMULATION_HZ))

setInterval(() => {
  emitWorldSnapshot()
}, Math.floor(1000 / SNAPSHOT_HZ))

io.use(requireAuthSocket)

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.userId}`)
  socket.join(`user:${socket.userId}`)

  socket.on('player:join', (payload, ack) => {
    const { name, avatar } = (payload && typeof payload === 'object') ? payload : {}
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 24 || !isValidAvatar(avatar)) {
      if (typeof ack === 'function') ack({ error: 'invalid_payload' })
      return
    }

    const spawn = randomSpawn()
    const world = tileCenter(spawn.col, spawn.row)
    const zoneKey = detectZoneKey(world.x, world.y)

    players[socket.userId] = {
      id: socket.userId,
      name: trimmed,
      avatar,
      x: world.x,
      y: world.y,
      vx: 0,
      vy: 0,
      col: spawn.col,
      row: spawn.row,
      facing: 'down',
      moving: false,
      zoneKey,
      muted: false,
      inputState: {
        seq: 0,
        inputX: 0,
        inputY: 0,
        facing: 'down',
        moving: false,
        clientTimeMs: Date.now(),
      },
      lastProcessedInputSeq: 0,
    }

    const others = Object.values(players)
      .filter(playerEntry => playerEntry.id !== socket.userId)
      .map(serializePlayerState)
    socket.emit('room:state', others)

    if (typeof ack === 'function') {
      ack({ col: spawn.col, row: spawn.row, x: world.x, y: world.y })
    }

    socket.broadcast.emit('player:joined', serializePlayerState(players[socket.userId]))
    emitWorldSnapshot()
  })

  socket.on('player:input', (payload) => {
    const player = players[socket.userId]
    if (!player || !payload || typeof payload !== 'object') return

    const seq = Number.isInteger(payload.seq) ? payload.seq : null
    const inputX = Number.isFinite(payload.inputX) ? payload.inputX : null
    const inputY = Number.isFinite(payload.inputY) ? payload.inputY : null
    const moving = typeof payload.moving === 'boolean' ? payload.moving : null
    const facing = isValidDirection(payload.facing) ? payload.facing : null
    const clientTimeMs = Number.isFinite(payload.clientTimeMs) ? payload.clientTimeMs : Date.now()
    if (seq === null || inputX === null || inputY === null || moving === null || facing === null) {
      return
    }

    const lastInputSeq = Number.isInteger(player.inputState?.seq) ? player.inputState.seq : -1
    if (seq < lastInputSeq) return

    const normalized = normalizeInput(inputX, inputY, moving)
    player.inputState = {
      seq,
      inputX: normalized.inputX,
      inputY: normalized.inputY,
      facing,
      moving: normalized.moving,
      clientTimeMs,
    }
  })

  socket.on('player:voice', ({ muted }) => {
    const player = players[socket.userId]
    if (!player || typeof muted !== 'boolean') return
    player.muted = muted
    socket.broadcast.emit('player:voice', { id: socket.userId, muted })
  })

  socket.on('chat:message', (payload) => {
    const player = players[socket.userId]
    if (!player || !payload || typeof payload !== 'object') return

    const rawBody = typeof payload.body === 'string'
      ? payload.body
      : (typeof payload.text === 'string' ? payload.text : '')
    const body = rawBody.trim()
    if (!body || body.length > 500) return
    if (looksLikeReservedCommand(body)) return

    const mentions = normalizeChatMentions(payload.mentions)

    const now = Date.now()
    const rateCheck = chatRateLimiter.canSend(socket.userId, now)
    if (!rateCheck.allowed) {
      socket.emit('chat:rate_limited', { retryAfterMs: rateCheck.retryAfterMs })
      return
    }

    io.emit('chat:message', {
      id: socket.userId,
      name: player.name,
      text: body,
      body,
      mentions,
      timestamp: now,
    })
  })

  socket.on('tag:send', (payload, ack) => {
    const result = handleTagSend({
      socket,
      io,
      players,
      payload,
    })
    if (typeof ack === 'function') ack(result)
  })

  socket.on('teleport:request', (payload, ack) => {
    const result = handleTeleportRequest({
      socket,
      io,
      players,
      payload,
      teleportRequests,
    })
    if (typeof ack === 'function') ack(result)
  })

  socket.on('teleport:respond', (payload, ack) => {
    const result = handleTeleportRespond({
      socket,
      io,
      players,
      payload,
      teleportRequests,
      isValidTile,
      tileCenter,
      detectZoneKey,
    })
    if (result.ok && result.status === 'accepted') emitWorldSnapshot()
    if (typeof ack === 'function') ack(result)
  })

  socket.on('disconnect', () => {
    const clearedTeleportRequests = teleportRequests.clearForUser(socket.userId)
    for (const request of clearedTeleportRequests) {
      if (request.senderId === socket.userId) {
        io.to(`user:${request.targetId}`).emit('teleport:request_cleared', {
          requestId: request.id,
          reason: 'sender_disconnected',
        })
      } else if (request.targetId === socket.userId) {
        io.to(`user:${request.senderId}`).emit('teleport:result', {
          requestId: request.id,
          status: 'failed',
          reason: 'target_offline',
          targetUserId: request.targetId,
        })
      }
    }
    chatRateLimiter.clear(socket.userId)
    const player = players[socket.userId]
    if (player) {
      delete players[socket.userId]
      io.emit('player:left', { id: socket.userId })
      emitWorldSnapshot()
    }
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
})
