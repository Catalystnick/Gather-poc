import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' }
})

// In-memory room state
// { [socketId]: { id, name, avatar: { shape, color }, x, y, z } }
const players = {}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  socket.on('player:join', ({ name, avatar }) => {
    players[socket.id] = { id: socket.id, name, avatar, x: 0, y: 0.5, z: 0 }

    // Send existing players to the new client (excluding self)
    const others = Object.values(players)
      .filter(p => p.id !== socket.id)
      .map(({ id, name, avatar, x, y, z }) => ({ id, name, avatar, position: { x, y, z } }))
    socket.emit('room:state', others)

    // Notify everyone else of the new player
    const { id, x, y, z } = players[socket.id]
    socket.broadcast.emit('player:joined', {
      id, name, avatar, position: { x, y, z }
    })

    console.log(`[join] ${name} (${socket.id})`)
  })

  socket.on('player:move', ({ x, y, z }) => {
    const player = players[socket.id]
    if (!player) return
    player.x = x
    player.y = y
    player.z = z
    socket.broadcast.emit('player:updated', { id: socket.id, position: { x, y, z } })
  })

  // --- Chat (Phase 2) ---
  socket.on('chat:message', ({ text }) => {
    const player = players[socket.id]
    if (!player) return
    io.emit('chat:message', {
      id: socket.id,
      name: player.name,
      text,
      timestamp: Date.now(),
    })
  })

  // --- Signaling relay (Phase 2 voice) ---
  socket.on('rtc:offer', ({ to, offer }) => {
    io.to(to).emit('rtc:offer', { from: socket.id, offer })
  })

  socket.on('rtc:answer', ({ to, answer }) => {
    io.to(to).emit('rtc:answer', { from: socket.id, answer })
  })

  socket.on('rtc:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('rtc:ice-candidate', { from: socket.id, candidate })
  })

  socket.on('rtc:hangup', ({ to }) => {
    io.to(to).emit('rtc:hangup', { from: socket.id })
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

const PORT = 3001
httpServer.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
