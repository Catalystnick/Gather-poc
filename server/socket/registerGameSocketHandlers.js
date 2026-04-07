import { normalizeInput } from '../world/movementMath.js'
import {
  handleTagSend,
  handleTeleportRequest,
  handleTeleportRespond,
} from '../chat/commandRouter.js'

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

function normalizeChatMentions(rawMentions, players) {
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

async function resolveSocketTenantContext({ socket, resolveTenantContext, enableTenantSocketContext }) {
  if (!enableTenantSocketContext) return true
  try {
    const context = await resolveTenantContext(socket.userId)
    socket.data.tenantContext = context
    return true
  } catch (error) {
    console.error('[tenant] socket context lookup failed for user:', socket.userId, error)
    return false
  }
}

function createPlayerState({ socket, trimmedName, avatar, spawn, world, zoneKey }) {
  return {
    id: socket.userId,
    name: trimmedName,
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
}

export function registerGameSocketHandlers({
  io,
  runtime,
  teleportRequests,
  chatRateLimiter,
  resolveTenantContext,
  enableTenantSocketContext,
}) {
  const { players } = runtime

  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.userId}`)
    socket.join(`user:${socket.userId}`)

    socket.on('player:join', async (payload, ack) => {
      const hasTenantContext = await resolveSocketTenantContext({
        socket,
        resolveTenantContext,
        enableTenantSocketContext,
      })
      if (!hasTenantContext) {
        if (typeof ack === 'function') ack({ error: 'tenant_context_unavailable' })
        return
      }

      const { name, avatar } = (payload && typeof payload === 'object') ? payload : {}
      const trimmedName = typeof name === 'string' ? name.trim() : ''
      if (!trimmedName || trimmedName.length > 24 || !runtime.isValidAvatar(avatar)) {
        if (typeof ack === 'function') ack({ error: 'invalid_payload' })
        return
      }

      const spawn = runtime.randomSpawn()
      const world = runtime.tileCenter(spawn.col, spawn.row)
      const zoneKey = runtime.detectZoneKey(world.x, world.y)

      players[socket.userId] = createPlayerState({
        socket,
        trimmedName,
        avatar,
        spawn,
        world,
        zoneKey,
      })

      const others = Object.values(players)
        .filter(playerEntry => playerEntry.id !== socket.userId)
        .map(runtime.serializePlayerState)
      socket.emit('room:state', others)

      if (typeof ack === 'function') {
        ack({ col: spawn.col, row: spawn.row, x: world.x, y: world.y })
      }

      socket.broadcast.emit('player:joined', runtime.serializePlayerState(players[socket.userId]))
      runtime.emitWorldSnapshot(io)
    })

    socket.on('player:input', (payload) => {
      const player = players[socket.userId]
      if (!player || !payload || typeof payload !== 'object') return

      const seq = Number.isInteger(payload.seq) ? payload.seq : null
      const inputX = Number.isFinite(payload.inputX) ? payload.inputX : null
      const inputY = Number.isFinite(payload.inputY) ? payload.inputY : null
      const moving = typeof payload.moving === 'boolean' ? payload.moving : null
      const facing = runtime.isValidDirection(payload.facing) ? payload.facing : null
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

      const mentions = normalizeChatMentions(payload.mentions, players)

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
        isValidTile: runtime.isValidTile,
        tileCenter: runtime.tileCenter,
        detectZoneKey: runtime.detectZoneKey,
      })
      if (result.ok && result.status === 'accepted') runtime.emitWorldSnapshot(io)
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
        runtime.emitWorldSnapshot(io)
      }
    })
  })
}
