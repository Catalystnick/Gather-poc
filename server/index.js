import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { AccessToken } from 'livekit-server-sdk'

const app = express()
app.use(cors())
app.use(express.json())

// LiveKit token endpoint — requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880'
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || ''
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || ''

app.post('/livekit/token', async (req, res) => {
  const { roomName = 'gather-world', identity, name } = req.body || {}
  if (!identity || typeof identity !== 'string') {
    return res.status(400).json({ error: 'identity required' })
  }
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit not configured' })
  }
  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: '2h',
      name: name || identity,
    })
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
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
  cors: { origin: '*' }
})

// Validation helpers
const SHAPES = ['swordsman', 'box', 'sphere']
const isValidAvatar = (a) =>
  a && typeof a === 'object' &&
  SHAPES.includes(a.shape) &&
  typeof a.color === 'string' && a.color.length <= 32
const isValidPosition = (p) =>
  p && typeof p === 'object' &&
  typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'

// In-memory room state
// { [socketId]: { id, name, avatar: { shape, color }, x, y, z } }
const players = {}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  socket.on('player:join', ({ name, avatar }) => {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 24 || !isValidAvatar(avatar)) {
      console.warn(`[join] invalid payload from ${socket.id}`)
      return
    }
    players[socket.id] = { id: socket.id, name: trimmed, avatar, x: 0, y: 0.5, z: 0 }

    const others = Object.values(players)
      .filter(p => p.id !== socket.id)
      .map(({ id, name, avatar, x, y, z }) => ({ id, name, avatar, position: { x, y, z } }))
    socket.emit('room:state', others)

    const { id, x, y, z } = players[socket.id]
    socket.broadcast.emit('player:joined', {
      id, name, avatar, position: { x, y, z }
    })

    console.log(`[join] ${name} (${socket.id})`)
  })

  socket.on('player:move', ({ x, y, z }) => {
    const player = players[socket.id]
    if (!player || !isValidPosition({ x, y, z })) return
    player.x = x
    player.y = y
    player.z = z
    socket.broadcast.emit('player:updated', { id: socket.id, position: { x, y, z } })
  })

  // --- Chat (Phase 2) ---
  socket.on('chat:message', ({ text }) => {
    const player = players[socket.id]
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!player || !trimmed || trimmed.length > 500) return
    io.emit('chat:message', {
      id: socket.id,
      name: player.name,
      text: trimmed,
      timestamp: Date.now(),
    })
  })

  socket.on('disconnect', () => {
    const player = players[socket.id]
    if (player) {
      console.log(`[leave] ${player.name} (${socket.id})`)
      delete players[socket.id]
      io.emit('player:left', { id: socket.id })
    }
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on port ${PORT}`)
)
