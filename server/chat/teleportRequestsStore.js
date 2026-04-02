import { randomUUID } from 'crypto'

const DEFAULT_COOLDOWN_MS = 30_000

function pairKey(senderId, targetId) {
  return `${senderId}:${targetId}`
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

  createOrReplace({ senderId, senderName, targetId, message }) {
    const key = pairKey(senderId, targetId)
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

  getPendingForTarget(targetId) {
    return [...this.pendingById.values()]
      .filter((request) => request.targetId === targetId && request.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  respond({ requestId, targetId, decision }) {
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

    request.status = decision
    this.pendingById.delete(requestId)
    this.pendingByPair.delete(pairKey(request.senderId, request.targetId))

    return { ok: true, request }
  }

  clearForUser(userId) {
    const clearedRequests = []
    for (const [requestId, request] of this.pendingById.entries()) {
      if (request.senderId === userId || request.targetId === userId) {
        this.pendingById.delete(requestId)
        this.pendingByPair.delete(pairKey(request.senderId, request.targetId))
        clearedRequests.push(request)
      }
    }
    return clearedRequests
  }
}
