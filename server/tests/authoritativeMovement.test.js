import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInput, simulateAuthoritativeStep } from '../world/movementMath.js'

const TILE_PX = 16
const VALID_DIRECTIONS = new Set(['down', 'up', 'left', 'right'])

test('normalizes overshoot input to unit-length movement', () => {
  const normalized = normalizeInput(8, 6, true)
  assert(Math.abs(Math.hypot(normalized.inputX, normalized.inputY) - 1) < 1e-9)
  assert.equal(normalized.moving, true)
})

test('authoritative step blocks movement into collision tile', () => {
  const blockedTiles = new Set(['1:1'])
  const canOccupyWorld = (x, y) => {
    const col = Math.floor(x / TILE_PX)
    const row = Math.floor(y / TILE_PX)
    return !blockedTiles.has(`${col}:${row}`)
  }

  const player = {
    x: 8,
    y: 24,
    facing: 'right',
    lastProcessedInputSeq: 0,
  }
  const next = simulateAuthoritativeStep({
    player,
    input: {
      seq: 1,
      inputX: 1,
      inputY: 0,
      moving: true,
      facing: 'right',
    },
    dtSeconds: 1,
    speedPxPerSecond: TILE_PX,
    worldPxMax: 200,
    canOccupyWorld,
    isValidDirection: (value) => VALID_DIRECTIONS.has(value),
    detectZoneKey: () => null,
    tilePx: TILE_PX,
  })

  assert.equal(next.x, 8)
  assert.equal(next.vx, 0)
  assert.equal(next.moving, false)
})

test('speed is capped by normalized input magnitude', () => {
  const canOccupyWorld = () => true
  const speedPxPerSecond = 73.6
  const dtSeconds = 1 / 60
  const player = {
    x: 100,
    y: 100,
    facing: 'down',
    lastProcessedInputSeq: 0,
  }

  const next = simulateAuthoritativeStep({
    player,
    input: {
      seq: 7,
      inputX: 99,
      inputY: 0,
      moving: true,
      facing: 'right',
    },
    dtSeconds,
    speedPxPerSecond,
    worldPxMax: 960,
    canOccupyWorld,
    isValidDirection: (value) => VALID_DIRECTIONS.has(value),
    detectZoneKey: () => null,
    tilePx: TILE_PX,
  })

  const movedDistance = Math.hypot(next.x - player.x, next.y - player.y)
  assert(Math.abs(movedDistance - speedPxPerSecond * dtSeconds) < 1e-9)
})

test('lastProcessedInputSeq is monotonic', () => {
  const canOccupyWorld = () => true
  const player = {
    x: 50,
    y: 50,
    facing: 'down',
    lastProcessedInputSeq: 12,
  }

  const oldSeq = simulateAuthoritativeStep({
    player,
    input: {
      seq: 3,
      inputX: 0,
      inputY: 0,
      moving: false,
      facing: 'down',
    },
    dtSeconds: 1 / 60,
    speedPxPerSecond: 73.6,
    worldPxMax: 960,
    canOccupyWorld,
    isValidDirection: (value) => VALID_DIRECTIONS.has(value),
    detectZoneKey: () => null,
    tilePx: TILE_PX,
  })
  assert.equal(oldSeq.lastProcessedInputSeq, 12)

  const newSeq = simulateAuthoritativeStep({
    player,
    input: {
      seq: 20,
      inputX: 0,
      inputY: 0,
      moving: false,
      facing: 'down',
    },
    dtSeconds: 1 / 60,
    speedPxPerSecond: 73.6,
    worldPxMax: 960,
    canOccupyWorld,
    isValidDirection: (value) => VALID_DIRECTIONS.has(value),
    detectZoneKey: () => null,
    tilePx: TILE_PX,
  })
  assert.equal(newSeq.lastProcessedInputSeq, 20)
})
