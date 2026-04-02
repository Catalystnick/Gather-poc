export function createChatRateLimiter({
  burstTokens = 5,
  refillPerSecond = 3,
} = {}) {
  const capacity = Math.max(1, burstTokens)
  const refillRate = Math.max(0.01, refillPerSecond)
  const stateByUserId = new Map()

  function getState(userId, nowMs) {
    const existing = stateByUserId.get(userId)
    if (existing) return existing
    const next = { tokens: capacity, lastRefillMs: nowMs }
    stateByUserId.set(userId, next)
    return next
  }

  function refill(state, nowMs) {
    const elapsedMs = Math.max(0, nowMs - state.lastRefillMs)
    if (elapsedMs > 0) {
      const restored = (elapsedMs / 1000) * refillRate
      state.tokens = Math.min(capacity, state.tokens + restored)
      state.lastRefillMs = nowMs
    }
  }

  return {
    canSend(userId, nowMs = Date.now()) {
      const state = getState(userId, nowMs)
      refill(state, nowMs)

      if (state.tokens < 1) {
        const missing = 1 - state.tokens
        const retryAfterMs = Math.ceil((missing / refillRate) * 1000)
        return {
          allowed: false,
          retryAfterMs,
        }
      }

      state.tokens -= 1
      return {
        allowed: true,
        retryAfterMs: 0,
      }
    },

    clear(userId) {
      stateByUserId.delete(userId)
    },
  }
}
