import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { AccessToken } from 'livekit-server-sdk'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireAuthSocket } from './middleware/requireAuth.js'

const app = express()

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null

app.use(cors({
  origin: allowedOrigins ?? '*',
}))
app.use(express.json())

const tokenLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
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
  ...ZONE_KEYS.map(k => `gather-world-zone-${k}`),
])
const ZONE_ROOM_PATTERN = /^gather-world-zone-([a-z0-9_-]+)$/

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
  const zoneMatch = roomName.match(ZONE_ROOM_PATTERN)
  if (zoneMatch) {
    const requestedZone = zoneMatch[1]
    const player = players[authedUserId]
    if (tokenIntent === 'join' && (!player || player.zoneKey !== requestedZone)) {
      return res.status(403).json({ error: 'zone_access_denied' })
    }
  }
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit not configured' })
  }
  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: tokenIntent === 'prefetch' ? '30s' : '2h',
      name: name || identity,
    })
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: tokenIntent === 'join',
      canSubscribe: tokenIntent === 'join',
      canUpdateOwnMetadata: tokenIntent === 'join',
    })
    const token = await at.toJwt()
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

const SPAWN_RADIUS = 2
// Client SPEED = 5 u/s. 1.5× tolerance covers network jitter and frame-rate variation.
const MAX_SPEED = 7.5
// Minimum ms between chat messages per player (2 messages/second).
const CHAT_MIN_INTERVAL = 500

function randomSpawn() {
  const angle = Math.random() * Math.PI * 2
  return { x: Math.cos(angle) * SPAWN_RADIUS, y: 0.5, z: Math.sin(angle) * SPAWN_RADIUS }
}

// Validation helpers
const isValidAvatar = (a) =>
  a && typeof a === 'object' &&
  typeof a.shirt === 'string' && /^#[0-9A-Fa-f]{6}$/.test(a.shirt)
const isValidPosition = (p) =>
  p && typeof p === 'object' &&
  Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
  Math.abs(p.x) <= 10000 && Math.abs(p.y) <= 10000 && Math.abs(p.z) <= 10000

const VALID_DIRECTIONS = new Set(['down', 'up', 'left', 'right'])
const isValidDirection = (d) => typeof d === 'string' && VALID_DIRECTIONS.has(d)

// In-memory room state
// { [socketId]: { id, name, avatar: { shirt }, x, y, z } }
const players = {}

io.use(requireAuthSocket)

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.userId}`)

  socket.on('player:join', ({ name, avatar }, ack) => {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 24 || !isValidAvatar(avatar)) {
      console.warn(`[join] invalid payload from ${socket.userId}`)
      return
    }
    const pos = randomSpawn()
    // Use socket.userId (stable Supabase UUID) instead of socket.id —
    // survives reconnects so token refresh doesn't respawn the player.
    players[socket.userId] = { id: socket.userId, name: trimmed, avatar, x: pos.x, y: pos.y, z: pos.z, direction: 'down', moving: false, zoneKey: null }

    const others = Object.values(players)
      .filter(p => p.id !== socket.userId)
      .map(({ id, name, avatar, x, y, z, direction, moving, zoneKey }) => ({ id, name, avatar, position: { x, y, z }, direction, moving, zoneKey: zoneKey ?? null }))
    socket.emit('room:state', others)

    if (typeof ack === 'function') ack({ position: pos })

    const { id, x, y, z, direction, moving, zoneKey } = players[socket.userId]
    socket.broadcast.emit('player:joined', {
      id, name, avatar, position: { x, y, z }, direction, moving, zoneKey: zoneKey ?? null
    })

    console.log(`[join] ${name} (${socket.userId})`)
  })

  socket.on('player:move', ({ x, y, z, direction, moving, zoneKey }) => {
    const player = players[socket.userId]
    if (!player || !isValidPosition({ x, y, z })) return
    if (!isValidDirection(direction) || typeof moving !== 'boolean') return

    const now = Date.now()
    if (player.lastMoveTime !== undefined) {
      const elapsed = (now - player.lastMoveTime) / 1000
      const dx = x - player.x
      const dz = z - player.z
      const speed = Math.sqrt(dx * dx + dz * dz) / elapsed
      if (speed > MAX_SPEED) {
        console.warn(`[move] speed violation from ${socket.userId}: ${speed.toFixed(1)} u/s`)
        return
      }
    }

    const validZoneKey = ZONE_KEYS.includes(zoneKey) ? zoneKey : null
    player.x = x
    player.y = y
    player.z = z
    player.direction = direction
    player.moving = moving
    player.zoneKey = validZoneKey
    player.lastMoveTime = now
    socket.broadcast.emit('player:updated', { id: socket.userId, position: { x, y, z }, direction, moving, zoneKey: validZoneKey })
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

  socket.on('disconnect', () => {
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
