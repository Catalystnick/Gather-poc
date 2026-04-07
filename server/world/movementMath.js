export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function normalizeInput(inputX, inputY, moving) {
  if (!moving) return { inputX: 0, inputY: 0, moving: false }
  let nextX = Number.isFinite(inputX) ? clamp(inputX, -1, 1) : 0
  let nextY = Number.isFinite(inputY) ? clamp(inputY, -1, 1) : 0
  const len = Math.hypot(nextX, nextY)
  if (len > 1) {
    nextX /= len
    nextY /= len
  }
  const isMoving = Math.abs(nextX) > 0.0001 || Math.abs(nextY) > 0.0001
  return {
    inputX: isMoving ? nextX : 0,
    inputY: isMoving ? nextY : 0,
    moving: isMoving,
  }
}

export function resolveFacingFromVelocity(vx, vy, fallback) {
  if (Math.abs(vx) >= Math.abs(vy)) {
    if (Math.abs(vx) > 0.0001) return vx > 0 ? 'right' : 'left'
    return fallback
  }
  if (Math.abs(vy) > 0.0001) return vy > 0 ? 'down' : 'up'
  return fallback
}

export function simulateAuthoritativeStep({
  player,
  input,
  dtSeconds,
  speedPxPerSecond,
  worldPxMax,
  canOccupyWorld,
  isValidDirection,
  detectZoneKey,
  tilePx,
}) {
  const normalized = normalizeInput(input.inputX, input.inputY, !!input.moving)
  let velocityX = normalized.inputX * speedPxPerSecond
  let velocityY = normalized.inputY * speedPxPerSecond

  let nextX = player.x
  let nextY = player.y

  if (velocityX !== 0) {
    const candidateX = clamp(player.x + velocityX * dtSeconds, 0, worldPxMax)
    if (canOccupyWorld(candidateX, player.y)) {
      nextX = candidateX
    } else {
      velocityX = 0
    }
  }

  if (velocityY !== 0) {
    const candidateY = clamp(player.y + velocityY * dtSeconds, 0, worldPxMax)
    if (canOccupyWorld(nextX, candidateY)) {
      nextY = candidateY
    } else {
      velocityY = 0
    }
  }

  const moved = Math.abs(nextX - player.x) > 0.0001 || Math.abs(nextY - player.y) > 0.0001
  const seq = Number.isInteger(input.seq) ? input.seq : 0
  const facing = isValidDirection(input.facing)
    ? input.facing
    : resolveFacingFromVelocity(velocityX, velocityY, player.facing)

  return {
    x: nextX,
    y: nextY,
    vx: velocityX,
    vy: velocityY,
    moving: moved && normalized.moving,
    facing,
    lastProcessedInputSeq: Math.max(player.lastProcessedInputSeq ?? 0, seq),
    col: Math.floor(nextX / tilePx),
    row: Math.floor(nextY / tilePx),
    zoneKey: detectZoneKey(nextX, nextY),
  }
}
