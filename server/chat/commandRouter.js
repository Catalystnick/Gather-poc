import { emitTagIncoming, resolveOnlineTargets } from './tagService.js'

function cleanMessage(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed
}

function hasMessageContent(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function getPlayer(players, userId) {
  if (players instanceof Map) return players.get(userId) ?? null
  return players[userId] ?? null
}

function listPlayers(players) {
  if (players instanceof Map) return [...players.values()]
  return Object.values(players)
}

function chooseTeleportDestination({ players, targetCol, targetRow, isValidTile }) {
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [0, 0],
  ]

  const occupied = new Set(listPlayers(players).map((player) => `${player.col}:${player.row}`))

  for (const [dc, dr] of offsets) {
    const col = targetCol + dc
    const row = targetRow + dr
    if (!isValidTile(col, row)) continue
    if (!occupied.has(`${col}:${row}`)) return { col, row }
  }

  return null
}

export function handleTagSend({ socket, io, players, payload }) {
  const sender = getPlayer(players, socket.userId)
  if (!sender) {
    return { ok: false, error: 'sender_not_joined' }
  }

  if (!hasMessageContent(payload?.message)) {
    return { ok: false, error: 'empty_message' }
  }

  const message = cleanMessage(payload?.message)
  if (!message) {
    return { ok: false, error: 'message_required' }
  }
  console.log(`[tag] ${socket.userId} (${sender.name}) -> "${message}"`)

  const { accepted, rejected } = resolveOnlineTargets({
    targetUserIds: payload?.targetUserIds,
    players,
    senderId: socket.userId,
  })

  if (!accepted.length) {
    return {
      ok: false,
      error: 'no_valid_targets',
      rejected,
    }
  }

  const delivery = emitTagIncoming({
    io,
    players,
    senderId: socket.userId,
    senderName: sender.name,
    acceptedTargetIds: accepted,
    message,
  })

  return {
    ok: true,
    sent: delivery.recipients,
    rejected,
    timestamp: delivery.timestamp,
  }
}

export function handleTeleportRequest({
  socket,
  io,
  players,
  payload,
  teleportRequests,
  teleportContext,
}) {
  const sender = getPlayer(players, socket.userId)
  if (!sender) {
    return { ok: false, error: 'sender_not_joined' }
  }

  const worldId = typeof teleportContext?.worldId === 'string' ? teleportContext.worldId : ''
  const tenantId = typeof teleportContext?.tenantId === 'string' ? teleportContext.tenantId : ''
  if (!worldId || !tenantId) {
    return { ok: false, error: 'invalid_scope' }
  }

  const message = cleanMessage(payload?.message)
  if (!message) {
    return { ok: false, error: 'message_required' }
  }
  console.log(`[teleport:request] ${socket.userId} (${sender.name}) -> "${message}"`)

  const { accepted, rejected } = resolveOnlineTargets({
    targetUserIds: payload?.targetUserIds,
    players,
    senderId: socket.userId,
  })

  if (!accepted.length) {
    return {
      ok: false,
      error: 'no_valid_targets',
      rejected,
    }
  }

  const sent = []
  const cooldown = []

  for (const targetId of accepted) {
    const result = teleportRequests.createOrReplace({
      worldId,
      tenantId,
      senderId: socket.userId,
      senderName: sender.name,
      targetId,
      message,
    })

    if (!result.ok) {
      cooldown.push({
        userId: targetId,
        reason: result.code,
        retryAfterMs: result.retryAfterMs,
      })
      continue
    }

    io.to(`user:${targetId}`).emit('teleport:incoming', {
      requestId: result.request.id,
      fromUserId: socket.userId,
      fromName: sender.name,
      message,
      timestamp: result.request.createdAt,
    })
    if (result.replacedRequestId) {
      io.to(`user:${targetId}`).emit('teleport:request_cleared', {
        requestId: result.replacedRequestId,
        reason: 'replaced',
      })
    }

    sent.push({
      userId: targetId,
      requestId: result.request.id,
      replacedRequestId: result.replacedRequestId,
    })
  }

  if (!sent.length) {
    return {
      ok: false,
      error: 'cooldown',
      rejected,
      cooldown,
    }
  }

  return {
    ok: true,
    sent,
    rejected,
    cooldown,
  }
}

export function handleTeleportRespond({
  socket,
  io,
  players,
  payload,
  teleportRequests,
  teleportContext,
  isValidTile,
  tileCenter,
  detectZoneKey,
}) {
  const responder = getPlayer(players, socket.userId)
  if (!responder) {
    return { ok: false, error: 'responder_not_joined' }
  }

  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
  const decision = payload?.decision
  if (!requestId) {
    return { ok: false, error: 'request_id_required' }
  }

  const worldId = typeof teleportContext?.worldId === 'string' ? teleportContext.worldId : ''
  const tenantId = typeof teleportContext?.tenantId === 'string' ? teleportContext.tenantId : ''
  if (!worldId || !tenantId) {
    return { ok: false, error: 'invalid_scope' }
  }

  const response = teleportRequests.respond({
    requestId,
    targetId: socket.userId,
    decision,
    worldId,
    tenantId,
  })

  if (!response.ok) {
    return { ok: false, error: response.code }
  }

  const request = response.request
  const sender = getPlayer(players, request.senderId)
  if (!sender) {
    io.to(`user:${request.senderId}`).emit('teleport:result', {
      requestId,
      status: 'failed',
      reason: 'sender_offline',
      targetUserId: socket.userId,
    })

    return { ok: false, error: 'sender_offline' }
  }

  if (decision === 'decline') {
    io.to(`user:${request.senderId}`).emit('teleport:result', {
      requestId,
      status: 'declined',
      targetUserId: socket.userId,
      targetName: responder.name,
    })

    return {
      ok: true,
      status: 'declined',
    }
  }

  const destination = chooseTeleportDestination({
    players,
    targetCol: sender.col,
    targetRow: sender.row,
    isValidTile,
  })

  if (!destination) {
    io.to(`user:${request.senderId}`).emit('teleport:result', {
      requestId,
      status: 'failed',
      reason: 'no_valid_tile',
      targetUserId: socket.userId,
    })

    return { ok: false, error: 'no_valid_tile' }
  }

  responder.col = destination.col
  responder.row = destination.row
  const world = tileCenter(destination.col, destination.row)
  responder.x = world.x
  responder.y = world.y
  responder.vx = 0
  responder.vy = 0
  responder.inputState = {
    seq: Number.isInteger(responder.lastProcessedInputSeq)
      ? responder.lastProcessedInputSeq
      : 0,
    inputX: 0,
    inputY: 0,
    facing: responder.facing,
    moving: false,
    clientTimeMs: Date.now(),
  }
  responder.moving = false
  responder.zoneKey = detectZoneKey(responder.x, responder.y) ?? sender.zoneKey ?? null

  io.to(`user:${request.senderId}`).emit('teleport:result', {
    requestId,
    status: 'accepted',
    targetUserId: socket.userId,
    targetName: responder.name,
  })

  io.to(`user:${socket.userId}`).emit('teleport:result', {
    requestId,
    status: 'accepted',
    senderUserId: sender.id,
    senderName: sender.name,
  })

  return {
    ok: true,
    status: 'accepted',
    destination,
  }
}
