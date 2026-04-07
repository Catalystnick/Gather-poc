import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatRateLimiter } from '../chat/chatRateLimiter.js'

test('allows burst of 5 and rejects the 6th immediate message', () => {
  const limiter = createChatRateLimiter({ burstTokens: 5, refillPerSecond: 3 })
  const userId = 'u1'
  const now = 1_000

  for (let index = 0; index < 5; index += 1) {
    const result = limiter.canSend(userId, now)
    assert.equal(result.allowed, true)
  }

  const sixth = limiter.canSend(userId, now)
  assert.equal(sixth.allowed, false)
  assert.ok((sixth.retryAfterMs ?? 0) > 0)
})

test('refills at 3 messages per second', () => {
  const limiter = createChatRateLimiter({ burstTokens: 5, refillPerSecond: 3 })
  const userId = 'u2'

  for (let index = 0; index < 5; index += 1) {
    limiter.canSend(userId, 0)
  }

  const at200ms = limiter.canSend(userId, 200)
  assert.equal(at200ms.allowed, false)

  const at334ms = limiter.canSend(userId, 334)
  assert.equal(at334ms.allowed, true)

  const nextImmediate = limiter.canSend(userId, 334)
  assert.equal(nextImmediate.allowed, false)
})

test('clearing user state resets limiter for fresh burst', () => {
  const limiter = createChatRateLimiter({ burstTokens: 5, refillPerSecond: 3 })
  const userId = 'u3'

  for (let index = 0; index < 5; index += 1) {
    limiter.canSend(userId, 0)
  }
  assert.equal(limiter.canSend(userId, 0).allowed, false)

  limiter.clear(userId)
  assert.equal(limiter.canSend(userId, 1).allowed, true)
})
