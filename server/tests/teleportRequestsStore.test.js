import test from 'node:test'
import assert from 'node:assert/strict'
import { TeleportRequestsStore } from '../chat/teleportRequestsStore.js'

test('replaces pending request for same sender-target pair', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })

  const first = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  const second = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'second',
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.ok(second.replacedRequestId)
  assert.equal(store.getPendingForTarget({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    targetId: 't1',
  }).length, 1)
  assert.equal(store.getPendingForTarget({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    targetId: 't1',
  })[0].message, 'second')
})

test('enforces cooldown per sender-target pair', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 30_000 })

  const first = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  const second = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
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

test('scopes cooldown by world and tenant context', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 30_000 })

  const first = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  const second = store.createOrReplace({
    worldId: 'world-b',
    tenantId: 'tenant-b',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'second',
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
})

test('respond validates target ownership', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })
  const created = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
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
    worldId: 'world-a',
    tenantId: 'tenant-a',
  })

  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'forbidden')

  const accepted = store.respond({
    requestId: created.request.id,
    targetId: 't1',
    decision: 'accept',
    worldId: 'world-a',
    tenantId: 'tenant-a',
  })

  assert.equal(accepted.ok, true)
  assert.equal(store.getPendingForTarget({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    targetId: 't1',
  }).length, 0)
})

test('respond rejects cross-instance resolution', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })
  const created = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })

  if (!created.ok) throw new Error('Expected request creation to succeed')

  const result = store.respond({
    requestId: created.request.id,
    targetId: 't1',
    decision: 'accept',
    worldId: 'world-b',
    tenantId: 'tenant-a',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_same_instance')
})

test('clearForUserInWorld returns removed requests only for the user world', () => {
  const store = new TeleportRequestsStore({ cooldownMs: 0 })
  const createdA = store.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't1',
    message: 'first',
  })
  const createdB = store.createOrReplace({
    worldId: 'world-b',
    tenantId: 'tenant-b',
    senderId: 's1',
    senderName: 'Sender',
    targetId: 't2',
    message: 'second',
  })

  if (!createdA.ok || !createdB.ok) throw new Error('Expected request creation to succeed')

  const cleared = store.clearForUserInWorld({ worldId: 'world-a', userId: 's1' })
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].id, createdA.request.id)
  assert.equal(store.getPendingForTarget({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    targetId: 't1',
  }).length, 0)
  assert.equal(store.getPendingForTarget({
    worldId: 'world-b',
    tenantId: 'tenant-b',
    targetId: 't2',
  }).length, 1)
})
