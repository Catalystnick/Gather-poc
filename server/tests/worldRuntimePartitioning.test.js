import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldRuntime } from '../world/runtime.js'

function createIoRecorder() {
  const events = []
  return {
    events,
    to(roomName) {
      return {
        emit(eventName, payload) {
          events.push({ roomName, eventName, payload })
        },
      }
    },
  }
}

test('emits world snapshots to world-scoped rooms only', () => {
  const runtime = createWorldRuntime()
  runtime.setPlayer('world_a', 'u1', {
    id: 'u1',
    name: 'A',
    avatar: { shirt: '#112233' },
    x: 10,
    y: 10,
    vx: 0,
    vy: 0,
    col: 0,
    row: 0,
    facing: 'down',
    moving: false,
    zoneKey: null,
    muted: false,
    inputState: { seq: 0, inputX: 0, inputY: 0, facing: 'down', moving: false, clientTimeMs: 1 },
    lastProcessedInputSeq: 0,
  })
  runtime.setPlayer('world_b', 'u2', {
    id: 'u2',
    name: 'B',
    avatar: { shirt: '#445566' },
    x: 20,
    y: 20,
    vx: 0,
    vy: 0,
    col: 1,
    row: 1,
    facing: 'down',
    moving: false,
    zoneKey: null,
    muted: false,
    inputState: { seq: 0, inputX: 0, inputY: 0, facing: 'down', moving: false, clientTimeMs: 1 },
    lastProcessedInputSeq: 0,
  })

  const io = createIoRecorder()
  runtime.emitWorldSnapshot(io)

  assert.equal(io.events.length, 2)
  const roomNames = new Set(io.events.map(entry => entry.roomName))
  assert.equal(roomNames.has('world:world_a'), true)
  assert.equal(roomNames.has('world:world_b'), true)

  const worldASnapshot = io.events.find(entry => entry.roomName === 'world:world_a')?.payload
  const worldBSnapshot = io.events.find(entry => entry.roomName === 'world:world_b')?.payload
  assert.equal(worldASnapshot.worldId, 'world_a')
  assert.equal(worldBSnapshot.worldId, 'world_b')
  assert.equal(worldASnapshot.players.length, 1)
  assert.equal(worldBSnapshot.players.length, 1)
  assert.equal(worldASnapshot.players[0].id, 'u1')
  assert.equal(worldBSnapshot.players[0].id, 'u2')
})

test('removing last player deletes empty world partition', () => {
  const runtime = createWorldRuntime()
  runtime.setPlayer('world_a', 'u1', {
    id: 'u1',
    name: 'A',
    avatar: { shirt: '#112233' },
    x: 10,
    y: 10,
    vx: 0,
    vy: 0,
    col: 0,
    row: 0,
    facing: 'down',
    moving: false,
    zoneKey: null,
    muted: false,
    inputState: { seq: 0, inputX: 0, inputY: 0, facing: 'down', moving: false, clientTimeMs: 1 },
    lastProcessedInputSeq: 0,
  })

  const removed = runtime.removePlayer('world_a', 'u1')
  assert.equal(removed?.id, 'u1')
  assert.equal(runtime.getWorldPlayers('world_a'), null)
})
