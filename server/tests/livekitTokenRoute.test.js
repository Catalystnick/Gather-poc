import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveLivekitRoomName, isValidZoneKey } from '../routes/livekitTokenRoute.js'

test('deriveLivekitRoomName returns proximity room when zone key is missing', () => {
  const roomName = deriveLivekitRoomName('world-123', undefined)
  assert.equal(roomName, 'gather-tenant-interior-world-123')
})

test('deriveLivekitRoomName returns zone room when zone key is present', () => {
  const roomName = deriveLivekitRoomName('world-123', 'design')
  assert.equal(roomName, 'gather-tenant-interior-world-123-zone-design')
})

test('deriveLivekitRoomName trims zone key', () => {
  const roomName = deriveLivekitRoomName('world-123', '  dev ')
  assert.equal(roomName, 'gather-tenant-interior-world-123-zone-dev')
})

test('isValidZoneKey validates optional zone key format', () => {
  assert.equal(isValidZoneKey(undefined), true)
  assert.equal(isValidZoneKey('dev'), true)
  assert.equal(isValidZoneKey('dev-zone_01'), true)
  assert.equal(isValidZoneKey(''), false)
  assert.equal(isValidZoneKey('   '), false)
  assert.equal(isValidZoneKey('bad key!'), false)
})
