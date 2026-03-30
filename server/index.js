import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { AccessToken } from 'livekit-server-sdk'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth, requireAuthSocket } from './middleware/requireAuth.js'
import { TeleportRequestsStore } from './chat/teleportRequestsStore.js'
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
  cors: { origin: allowedOrigins ?? '*' }
})

// Grid dimensions — must match client COLS/ROWS in FloorMap.tsx.
const GRID_COLS = 60
const GRID_ROWS = 60

// Spawn in the open central area, clear of all zone fences.
// Cols 27–33, rows 27–33 map to the world centre with no fences.
const SPAWN_COL_MIN = 27
const SPAWN_COL_MAX = 33
const SPAWN_ROW_MIN = 27
const SPAWN_ROW_MAX = 33

// Maximum Manhattan distance per move event — must be 1 for grid movement.
const MAX_STEP = 1
// Minimum ms between accepted move events. Slightly under TWEEN_DURATION (150ms)
// to absorb frame-rate jitter without dropping legitimate inputs.
const MOVE_MIN_INTERVAL = 100
// Minimum ms between chat messages per player (2 messages/second).
const CHAT_MIN_INTERVAL = 500

/** Pick a random spawn tile from the central open area. */
function randomSpawn() {
  const col = SPAWN_COL_MIN + Math.floor(Math.random() * (SPAWN_COL_MAX - SPAWN_COL_MIN + 1))
  const row = SPAWN_ROW_MIN + Math.floor(Math.random() * (SPAWN_ROW_MAX - SPAWN_ROW_MIN + 1))
  return { col, row }
}

// Validation helpers
/** Validate avatar payload format from client join requests. */
const isValidAvatar = (avatar) =>
  avatar && typeof avatar === 'object' &&
  typeof avatar.shirt === 'string' && /^#[0-9A-Fa-f]{6}$/.test(avatar.shirt)

/** Validate incoming tile coordinates are within server world bounds. */
const isValidTile = (col, row) =>
  Number.isInteger(col) && Number.isInteger(row) &&
  col >= 0 && col < GRID_COLS &&
  row >= 0 && row < GRID_ROWS

const VALID_DIRECTIONS = new Set(['down', 'up', 'left', 'right'])
/** Validate replicated movement direction enum. */
const isValidDirection = (direction) => typeof direction === 'string' && VALID_DIRECTIONS.has(direction)

// In-memory room state
// { [userId]: { id, name, avatar, col, row, direction, moving, zoneKey, muted, lastMoveTime, lastChatTime } }
const players = {}
const teleportRequests = new TeleportRequestsStore({ cooldownMs: 30_000 })

io.use(requireAuthSocket)

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.userId}`)
  socket.join(`user:${socket.userId}`)

  socket.on('player:join', (payload, ack) => {
    const { name, avatar } = (payload && typeof payload === 'object') ? payload : {}
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 24 || !isValidAvatar(avatar)) {
      console.warn(`[join] invalid payload from ${socket.userId}`)
      if (typeof ack === 'function') ack({ error: 'invalid_payload' })
      return
    }
    const spawn = randomSpawn()
    // Use socket.userId (stable Supabase UUID) instead of socket.id —
    // survives reconnects so token refresh doesn't respawn the player.
    players[socket.userId] = {
      id: socket.userId,
      name: trimmed,
      avatar,
      col: spawn.col,
      row: spawn.row,
      direction: 'down',
      moving: false,
      zoneKey: null,
      muted: false,
    }

    const others = Object.values(players)
      .filter(playerEntry => playerEntry.id !== socket.userId)
      .map(({ id, name, avatar, col, row, direction, moving, zoneKey, muted }) => ({
        id, name, avatar, col, row, direction, moving, zoneKey: zoneKey ?? null, muted: !!muted,
      }))
    socket.emit('room:state', others)

    if (typeof ack === 'function') ack({ col: spawn.col, row: spawn.row })

    const { id, col, row, direction, moving, zoneKey, muted } = players[socket.userId]
    socket.broadcast.emit('player:joined', {
      id, name: trimmed, avatar, col, row, direction, moving, zoneKey: zoneKey ?? null, muted: !!muted,
    })

    console.log(`[join] ${trimmed} (${socket.userId}) at tile (${spawn.col}, ${spawn.row})`)
  })

  socket.on('player:move', ({ col, row, direction, moving, zoneKey }) => {
    const player = players[socket.userId]
    if (!player) return
    if (!isValidTile(col, row)) return
    if (!isValidDirection(direction) || typeof moving !== 'boolean') return

    // Reject moves larger than one tile (prevents teleportation).
    const dist = Math.abs(col - player.col) + Math.abs(row - player.row)
    if (dist > MAX_STEP) {
      console.warn(`[move] step violation from ${socket.userId}: dist=${dist}`)
      return
    }

    // Rate-limit only actual position changes (dist > 0).
    // Idle events (same tile, moving:false) are animation-only updates — they
    // must not update lastMoveTime or the buffered step that fires in the same
    // frame will be incorrectly rejected.
    const now = Date.now()
    if (dist > 0) {
      if (player.lastMoveTime !== undefined && (now - player.lastMoveTime) < MOVE_MIN_INTERVAL) {
        console.warn(`[move] rate violation from ${socket.userId}: ${now - player.lastMoveTime}ms since last move`)
        return
      }
      player.lastMoveTime = now
    }

    const validZoneKey = ZONE_KEYS.includes(zoneKey) ? zoneKey : null
    player.col = col
    player.row = row
    player.direction = direction
    player.moving = moving
    player.zoneKey = validZoneKey
    socket.broadcast.emit('player:updated', { id: socket.userId, col, row, direction, moving, zoneKey: validZoneKey })
  })

  socket.on('player:voice', ({ muted }) => {
    const player = players[socket.userId]
    if (!player || typeof muted !== 'boolean') return
    player.muted = muted
    socket.broadcast.emit('player:voice', { id: socket.userId, muted })
  })

  socket.on('chat:message', ({ text }) => {
    const player = players[socket.userId]
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!player || !trimmed || trimmed.length > 500) return

    const now = Date.now()
    if (player.lastChatTime !== undefined && now - player.lastChatTime < CHAT_MIN_INTERVAL) {
      console.warn(`[chat] rate limit from ${socket.userId}`)
      return
    }

    player.lastChatTime = now
    io.emit('chat:message', {
      id: socket.userId,
      name: player.name,
      text: trimmed,
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
    })
    if (typeof ack === 'function') ack(result)
  })

  socket.on('disconnect', () => {
    teleportRequests.clearForUser(socket.userId)
    const player = players[socket.userId]
    if (player) {
      console.log(`[leave] ${player.name} (${socket.userId})`)
      delete players[socket.userId]
      io.emit('player:left', { id: socket.userId })
    }
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on port ${PORT}`)
)
