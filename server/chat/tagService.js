function normalizeTargetIds(targetUserIds) {
  if (!Array.isArray(targetUserIds)) return []
  const unique = new Set()
  for (const value of targetUserIds) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    unique.add(trimmed)
  }
  return [...unique]
}

export function resolveOnlineTargets({ targetUserIds, players, senderId }) {
  const requested = normalizeTargetIds(targetUserIds)
  const accepted = []
  const rejected = []

  for (const targetId of requested) {
    if (targetId === senderId) {
      rejected.push({ userId: targetId, reason: 'self_target' })
      continue
    }

    if (!players[targetId]) {
      rejected.push({ userId: targetId, reason: 'offline' })
      continue
    }

    accepted.push(targetId)
  }

  return { accepted, rejected }
}

export function emitTagIncoming({ io, players, senderId, senderName, acceptedTargetIds, message }) {
  const now = Date.now()

  for (const targetId of acceptedTargetIds) {
    io.to(`user:${targetId}`).emit('tag:incoming', {
      id: `${senderId}:${targetId}:${now}`,
      fromUserId: senderId,
      fromName: senderName,
      message,
      timestamp: now,
    })
  }

  return {
    timestamp: now,
    recipients: acceptedTargetIds.map((userId) => ({
      userId,
      name: players[userId]?.name ?? userId,
    })),
  }
}
