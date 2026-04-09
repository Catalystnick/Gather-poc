function createOutcomeBucket() {
  return {
    success: 0,
    failure: 0,
    failureReasons: {},
  }
}

const state = {
  worldJoin: createOutcomeBucket(),
  worldChange: createOutcomeBucket(),
  livekitToken: {
    issued: 0,
    rejected: 0,
    rejectionReasons: {},
  },
  invites: {
    created: 0,
    emailAttempted: 0,
    emailSent: 0,
    emailFailed: 0,
    emailFailureReasons: {},
  },
  snapshots: {
    total: 0,
    totalPayloadBytes: 0,
    maxPayloadBytes: 0,
    lastPayloadBytes: 0,
    maxTickLagMs: 0,
    lastTickLagMs: 0,
  },
  worldPlayerCounts: {},
}

function incrementReasonCounter(reasonMap, reason) {
  const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'unknown'
  reasonMap[normalizedReason] = (reasonMap[normalizedReason] ?? 0) + 1
}

function observeOutcome(bucket, { ok, reason }) {
  if (ok) {
    bucket.success += 1
    return
  }
  bucket.failure += 1
  incrementReasonCounter(bucket.failureReasons, reason)
}

export function observeWorldJoinOutcome({ ok, reason }) {
  observeOutcome(state.worldJoin, { ok, reason })
}

export function observeWorldChangeOutcome({ ok, reason }) {
  observeOutcome(state.worldChange, { ok, reason })
}

export function observeLivekitTokenIssued() {
  state.livekitToken.issued += 1
}

export function observeLivekitTokenRejected(reason) {
  state.livekitToken.rejected += 1
  incrementReasonCounter(state.livekitToken.rejectionReasons, reason)
}

export function observeInviteCreated() {
  state.invites.created += 1
}

export function observeInviteEmailAttempted() {
  state.invites.emailAttempted += 1
}

export function observeInviteEmailSent() {
  state.invites.emailSent += 1
}

export function observeInviteEmailFailed(reason) {
  state.invites.emailFailed += 1
  incrementReasonCounter(state.invites.emailFailureReasons, reason)
}

export function observeSnapshotStat({ worldId, playerCount, payloadBytes, tickLagMs }) {
  const safePayloadBytes = Number.isFinite(payloadBytes) ? Math.max(0, Math.floor(payloadBytes)) : 0
  const safeTickLagMs = Number.isFinite(tickLagMs) ? Math.max(0, Math.floor(tickLagMs)) : 0
  const normalizedWorldId = typeof worldId === 'string' && worldId.trim() ? worldId.trim() : 'unknown'

  state.snapshots.total += 1
  state.snapshots.totalPayloadBytes += safePayloadBytes
  state.snapshots.lastPayloadBytes = safePayloadBytes
  state.snapshots.maxPayloadBytes = Math.max(state.snapshots.maxPayloadBytes, safePayloadBytes)
  state.snapshots.lastTickLagMs = safeTickLagMs
  state.snapshots.maxTickLagMs = Math.max(state.snapshots.maxTickLagMs, safeTickLagMs)
  state.worldPlayerCounts[normalizedWorldId] = Number.isFinite(playerCount) ? Math.max(0, Math.floor(playerCount)) : 0
}

export function collectObservabilitySnapshot() {
  const totalSnapshots = state.snapshots.total
  const averagePayloadBytes = totalSnapshots
    ? Math.round(state.snapshots.totalPayloadBytes / totalSnapshots)
    : 0

  return {
    generatedAt: new Date().toISOString(),
    worldJoin: {
      ...state.worldJoin,
    },
    worldChange: {
      ...state.worldChange,
    },
    livekitToken: {
      ...state.livekitToken,
    },
    invites: {
      ...state.invites,
      emailFailureReasons: { ...state.invites.emailFailureReasons },
    },
    snapshots: {
      ...state.snapshots,
      averagePayloadBytes,
    },
    worldPlayerCounts: { ...state.worldPlayerCounts },
  }
}
