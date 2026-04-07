import { randomUUID } from 'crypto'

const DEFAULT_COOLDOWN_MS = 30_000

function scopedPairKey({ worldId, tenantId, senderId, targetId }) {
  return `${worldId}:${tenantId}:${senderId}:${targetId}`
}

function hasValidScope({ worldId, tenantId }) {
  return typeof worldId === 'string' && worldId
    && typeof tenantId === 'string' && tenantId
}

export class TeleportRequestsStore {
  constructor(options = {}) {
    this.cooldownMs = Number.isFinite(options.cooldownMs)
      ? Math.max(0, Number(options.cooldownMs))
      : DEFAULT_COOLDOWN_MS

    this.pendingByPair = new Map()
    this.pendingById = new Map()
    this.lastSentAtByPair = new Map()
  }

  createOrReplace({ worldId, tenantId, senderId, senderName, targetId, message }) {
    if (!hasValidScope({ worldId, tenantId })) {
      return { ok: false, code: 'invalid_scope' }
    }

    const key = scopedPairKey({ worldId, tenantId, senderId, targetId })
    const now = Date.now()
    const lastSentAt = this.lastSentAtByPair.get(key)
    if (lastSentAt !== undefined) {
      const retryAfterMs = this.cooldownMs - (now - lastSentAt)
      if (retryAfterMs > 0) {
        return {
          ok: false,
          code: 'cooldown',
          retryAfterMs,
        }
      }
    }

    const previousRequestId = this.pendingByPair.get(key)
    if (previousRequestId) {
      this.pendingById.delete(previousRequestId)
      this.pendingByPair.delete(key)
    }

    const request = {
      id: randomUUID(),
      worldId,
      tenantId,
      senderId,
      senderName,
      targetId,
      message,
      createdAt: now,
      status: 'pending',
    }

    this.pendingByPair.set(key, request.id)
    this.pendingById.set(request.id, request)
    this.lastSentAtByPair.set(key, now)

    return {
      ok: true,
      request,
      replacedRequestId: previousRequestId ?? null,
    }
  }

  getPendingForTarget({ worldId, tenantId, targetId }) {
    if (!hasValidScope({ worldId, tenantId })) return []
    return [...this.pendingById.values()]
      .filter((request) => request.targetId === targetId
        && request.worldId === worldId
        && request.tenantId === tenantId
        && request.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  respond({ requestId, targetId, decision, worldId, tenantId }) {
    if (!hasValidScope({ worldId, tenantId })) {
      return { ok: false, code: 'invalid_scope' }
    }

    const request = this.pendingById.get(requestId)
    if (!request || request.status !== 'pending') {
      return { ok: false, code: 'not_found' }
    }

    if (request.targetId !== targetId) {
      return { ok: false, code: 'forbidden' }
    }

    if (decision !== 'accept' && decision !== 'decline') {
      return { ok: false, code: 'invalid_decision' }
    }

    if (request.worldId !== worldId) {
      return { ok: false, code: 'not_same_instance' }
    }

    if (request.tenantId !== tenantId) {
      return { ok: false, code: 'not_allowed_cross_tenant' }
    }

    request.status = decision
    this.pendingById.delete(requestId)
    this.pendingByPair.delete(scopedPairKey({
      worldId: request.worldId,
      tenantId: request.tenantId,
      senderId: request.senderId,
      targetId: request.targetId,
    }))

    return { ok: true, request }
  }

  clearForUserInWorld({ worldId, userId }) {
    if (typeof worldId !== 'string' || !worldId) return []
    const clearedRequests = []
    for (const [requestId, request] of this.pendingById.entries()) {
      if (request.worldId !== worldId) continue
      if (request.senderId === userId || request.targetId === userId) {
        this.pendingById.delete(requestId)
        this.pendingByPair.delete(scopedPairKey({
          worldId: request.worldId,
          tenantId: request.tenantId,
          senderId: request.senderId,
          targetId: request.targetId,
        }))
        clearedRequests.push(request)
      }
    }
    return clearedRequests
  }
}
