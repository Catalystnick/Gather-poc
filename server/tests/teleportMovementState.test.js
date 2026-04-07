import test from 'node:test'
import assert from 'node:assert/strict'
import { TeleportRequestsStore } from '../chat/teleportRequestsStore.js'
import { handleTeleportRespond } from '../chat/commandRouter.js'

test('accepted teleport writes authoritative movement state', () => {
  const socket = { userId: 'target-1' }
  const io = { to: () => ({ emit: () => {} }) }
  const teleportRequests = new TeleportRequestsStore({ cooldownMs: 0 })

  const players = {
    'sender-1': {
      id: 'sender-1',
      name: 'Sender',
      col: 10,
      row: 10,
      x: 168,
      y: 168,
      facing: 'down',
      moving: false,
      lastProcessedInputSeq: 2,
      zoneKey: null,
    },
    'target-1': {
      id: 'target-1',
      name: 'Target',
      col: 20,
      row: 20,
      x: 328,
      y: 328,
      vx: 4,
      vy: 2,
      facing: 'left',
      moving: true,
      lastProcessedInputSeq: 9,
      zoneKey: null,
    },
  }

  const created = teleportRequests.createOrReplace({
    worldId: 'world-a',
    tenantId: 'tenant-a',
    senderId: 'sender-1',
    senderName: 'Sender',
    targetId: 'target-1',
    message: 'come here',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const result = handleTeleportRespond({
    socket,
    io,
    players,
    payload: { requestId: created.request.id, decision: 'accept' },
    teleportRequests,
    teleportContext: { worldId: 'world-a', tenantId: 'tenant-a' },
    isValidTile: () => true,
    tileCenter: (col, row) => ({ x: col * 16 + 8, y: row * 16 + 8 }),
    detectZoneKey: () => 'dev',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'accepted')
  assert.equal(players['target-1'].moving, false)
  assert.equal(players['target-1'].vx, 0)
  assert.equal(players['target-1'].vy, 0)
  assert.equal(players['target-1'].zoneKey, 'dev')
  assert.equal(players['target-1'].x, players['target-1'].col * 16 + 8)
  assert.equal(players['target-1'].y, players['target-1'].row * 16 + 8)
  assert.equal(players['target-1'].inputState.moving, false)
})
