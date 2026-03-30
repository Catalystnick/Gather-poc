import test from 'node:test'
import assert from 'node:assert/strict'
import { TeleportRequestsStore } from '../chat/teleportRequestsStore.js'

test('replaces pending request for same sender-target pair', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })

  const first = store.createOrReplace({
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  const second = store.createOrReplace({
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'second',
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.ok(second.replacedRequestId)
  assert.equal(store.getPendingForTarget('t1').length, 1)
  assert.equal(store.getPendingForTarget('t1')[0].message, 'second')
})

test('enforces cooldown per sender-target pair', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 30_000 })

  const first = store.createOrReplace({
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  const second = store.createOrReplace({
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'second',
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'cooldown')
  assert.ok((second.retryAfterMs ?? 0) > 0)
})

test('respond validates target ownership', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })
  const created = store.createOrReplace({
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  if (!created.ok) throw new Error('Expected request creation to succeed')

  const forbidden = store.respond({
    requestId: created.request.id,
    targetId: 't2',
    decision: 'accept',
  })

  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'forbidden')

  const accepted = store.respond({
    requestId: created.request.id,
    targetId: 't1',
    decision: 'accept',
  })

  assert.equal(accepted.ok, true)
  assert.equal(store.getPendingForTarget('t1').length, 0)
})
