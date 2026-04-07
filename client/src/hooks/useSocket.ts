import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  Direction,
  LocalAuthoritativeState,
  Player,
  PlayerInputState,
  RemotePlayer,
} from '../types'

// VITE_SERVER_URL overrides for deployed builds (e.g. Netlify → Render/Railway server).
// Otherwise connect to current origin — Vite proxies /socket.io to the backend,
// avoiding mixed-content errors when the page is served over HTTPS.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined
const TILE_PX = 16

type SnapshotPlayerPayload = {
  id: string
  name: string
  avatar: { shirt: string }
  x: number
  y: number
  vx: number
  vy: number
  facing: Direction
  moving: boolean
  lastProcessedInputSeq: number
  zoneKey: string | null
  muted: boolean
}

type WorldSnapshotPayload = {
  serverTimeMs: number
  tick: number
  worldId?: string
  players: SnapshotPlayerPayload[]
}

type JoinAckPayload = {
  x?: unknown
  y?: unknown
  col?: unknown
  row?: unknown
  worldId?: unknown
  fromWorldId?: unknown
  instanceType?: unknown
  unchanged?: unknown
  error?: unknown
}

type SocketEventHandlers = {
  onConnect: () => void
  onConnectError: (err: Error) => void
  onDisconnect: (reason: string) => void
  onRoomState: (players: SnapshotPlayerPayload[]) => void
  onPlayerJoined: (joinedPlayer: SnapshotPlayerPayload) => void
  onWorldSnapshot: (snapshot: WorldSnapshotPayload) => void
  onWorldChanged: (event: { worldId?: unknown; instanceType?: unknown }) => void
  onPlayerVoice: (event: { id: string; muted: boolean }) => void
  onPlayerLeft: (event: { id: string }) => void
}

function facingOrDefault(facing: unknown): Direction {
  return facing === 'up' || facing === 'left' || facing === 'right' ? facing : 'down'
}

function toRemotePlayer(
  payload: SnapshotPlayerPayload,
  snapshotTimeMs: number,
  serverTimeMs: number,
): RemotePlayer {
  const worldX = Number.isFinite(payload.x) ? payload.x : TILE_PX / 2
  const worldY = Number.isFinite(payload.y) ? payload.y : TILE_PX / 2
  const direction = facingOrDefault(payload.facing)
  return {
    id: payload.id,
    name: payload.name,
    avatar: payload.avatar,
    x: worldX,
    y: worldY,
    vx: Number.isFinite(payload.vx) ? payload.vx : 0,
    vy: Number.isFinite(payload.vy) ? payload.vy : 0,
    col: Math.floor(worldX / TILE_PX),
    row: Math.floor(worldY / TILE_PX),
    worldX,
    worldY,
    direction,
    moving: !!payload.moving,
    lastProcessedInputSeq: Number.isInteger(payload.lastProcessedInputSeq)
      ? payload.lastProcessedInputSeq
      : 0,
    snapshotTimeMs,
    serverTimeMs,
    zoneKey: payload.zoneKey ?? null,
    muted: !!payload.muted,
  }
}

function parseSpawnFromJoinAck(ack?: JoinAckPayload): { col: number; row: number } | null {
  if (!ack || ack.error) return null

  // New server shape (preferred): tile-space spawn.
  const colFromAck = typeof ack.col === 'number' ? ack.col : null
  const rowFromAck = typeof ack.row === 'number' ? ack.row : null
  if (colFromAck !== null && rowFromAck !== null) {
    return { col: colFromAck, row: rowFromAck }
  }

  // Backward-compatible fallback: world-space spawn.
  const x = typeof ack.x === 'number' ? ack.x : null
  const y = typeof ack.y === 'number' ? ack.y : null
  if (x === null || y === null) return null

  return {
    col: Math.floor(x / TILE_PX),
    row: Math.floor(y / TILE_PX),
  }
}

function buildRemotePlayersForRoomState(
  players: SnapshotPlayerPayload[],
  userId: string,
): Map<string, RemotePlayer> {
  // room:state is an immediate baseline snapshot after join.
  const snapshotTimeMs = performance.now()
  const serverTimeMs = Date.now()
  return new Map(
    players
      .filter((entry) => entry.id !== userId)
      .map((entry) => [entry.id, toRemotePlayer(entry, snapshotTimeMs, serverTimeMs)]),
  )
}

function applySnapshot(
  snapshot: WorldSnapshotPayload,
  userId: string,
): {
  local: LocalAuthoritativeState | null
  remote: Map<string, RemotePlayer>
} {
  const snapshotTimeMs = performance.now()
  const serverTimeMs = Number.isFinite(snapshot.serverTimeMs) ? snapshot.serverTimeMs : Date.now()
  const remote = new Map<string, RemotePlayer>()
  let local: LocalAuthoritativeState | null = null

  for (const playerState of snapshot.players ?? []) {
    const facing = facingOrDefault(playerState.facing)
    if (playerState.id === userId) {
      local = {
        x: playerState.x,
        y: playerState.y,
        vx: playerState.vx,
        vy: playerState.vy,
        facing,
        moving: !!playerState.moving,
        lastProcessedInputSeq: Number.isInteger(playerState.lastProcessedInputSeq)
          ? playerState.lastProcessedInputSeq
          : 0,
        serverTimeMs,
        zoneKey: playerState.zoneKey ?? null,
      }
      continue
    }

    remote.set(playerState.id, toRemotePlayer(playerState, snapshotTimeMs, serverTimeMs))
  }

  return { local, remote }
}

function bindSocketEventHandlers(
  socketClient: Socket,
  handlers: SocketEventHandlers,
): () => void {
  // Centralized bind/unbind keeps listener cleanup symmetric and avoids leaks.
  socketClient.on('connect', handlers.onConnect)
  socketClient.on('connect_error', handlers.onConnectError)
  socketClient.on('disconnect', handlers.onDisconnect)
  socketClient.on('room:state', handlers.onRoomState)
  socketClient.on('player:joined', handlers.onPlayerJoined)
  socketClient.on('world:snapshot', handlers.onWorldSnapshot)
  socketClient.on('world:changed', handlers.onWorldChanged)
  socketClient.on('player:voice', handlers.onPlayerVoice)
  socketClient.on('player:left', handlers.onPlayerLeft)

  return () => {
    socketClient.off('connect', handlers.onConnect)
    socketClient.off('connect_error', handlers.onConnectError)
    socketClient.off('disconnect', handlers.onDisconnect)
    socketClient.off('room:state', handlers.onRoomState)
    socketClient.off('player:joined', handlers.onPlayerJoined)
    socketClient.off('world:snapshot', handlers.onWorldSnapshot)
    socketClient.off('world:changed', handlers.onWorldChanged)
    socketClient.off('player:voice', handlers.onPlayerVoice)
    socketClient.off('player:left', handlers.onPlayerLeft)
  }
}

/** Connect socket.io and expose synchronized multiplayer state/events. */
export function useSocket(player: Player, accessToken: string, userId: string) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())
  const [serverSpawn, setServerSpawn] = useState<{ col: number; row: number } | null>(null)
  const [localAuthoritativeState, setLocalAuthoritativeState] = useState<LocalAuthoritativeState | null>(null)
  const [activeWorldId, setActiveWorldId] = useState<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [lastDisconnectReason, setLastDisconnectReason] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  // Keep a stable ref to the latest player data so the connect handler
  // always sends the current name/avatar without triggering a reconnect.
  const playerRef = useRef(player)
  playerRef.current = player

  // Token ref — updated on refresh without triggering a reconnect.
  // socket.auth is patched in-place so any future reconnect (e.g. network drop)
  // uses the latest token automatically.
  const tokenRef = useRef(accessToken)
  const socketRef = useRef<Socket | null>(null)
  const mainPlazaWorldIdRef = useRef<string | null>(null)
  const lastPortalTransitionKeyRef = useRef<string | null>(null)
  const canConnect = userId.trim().length > 0 && accessToken.trim().length > 0
  // Clears any stale multiplayer state when auth/session/socket context changes.
  const clearWorldRuntimeState = useCallback(() => {
    setServerSpawn(null)
    setLocalAuthoritativeState(null)
    setRemotePlayers(new Map())
  }, [])

  const applyWorldAck = useCallback((ack?: JoinAckPayload) => {
    const worldId = typeof ack?.worldId === 'string' ? ack.worldId.trim() : ''
    if (worldId) setActiveWorldId(worldId)
    if (ack?.instanceType === 'main_plaza' && worldId) {
      mainPlazaWorldIdRef.current = worldId
    }
  }, [])

  const joinCurrentPlayer = useCallback((socketClient: Socket) => {
    socketClient.emit(
      'world:join',
      { name: playerRef.current.name, avatar: playerRef.current.avatar },
      (ack?: JoinAckPayload) => {
        const spawn = parseSpawnFromJoinAck(ack)
        if (spawn) setServerSpawn(spawn)
        applyWorldAck(ack)
      },
    )
  }, [applyWorldAck])

  const handleConnectError = useCallback((err: Error) => {
    setStatus('error')
    setLastError(err?.message ?? String(err))
    setServerSpawn(null)
  }, [])

  const handleDisconnect = useCallback((reason: string) => {
    setStatus('disconnected')
    setLastDisconnectReason(String(reason))
    setActiveWorldId(null)
    clearWorldRuntimeState()
  }, [clearWorldRuntimeState])

  const handleRoomState = useCallback((players: SnapshotPlayerPayload[]) => {
    setRemotePlayers(buildRemotePlayersForRoomState(players, userId))
  }, [userId])

  const handlePlayerJoined = useCallback((joinedPlayer: SnapshotPlayerPayload) => {
    const snapshotTimeMs = performance.now()
    const serverTimeMs = Date.now()
    if (joinedPlayer.id === userId) return
    setRemotePlayers((prev) =>
      new Map(prev).set(
        joinedPlayer.id,
        toRemotePlayer(joinedPlayer, snapshotTimeMs, serverTimeMs),
      ),
    )
  }, [userId])

  const handleWorldSnapshot = useCallback((snapshot: WorldSnapshotPayload) => {
    if (typeof snapshot?.worldId === 'string' && snapshot.worldId.trim()) {
      setActiveWorldId(snapshot.worldId.trim())
    }
    const nextState = applySnapshot(snapshot, userId)
    setLocalAuthoritativeState(nextState.local)
    setRemotePlayers(nextState.remote)
  }, [userId])

  const handleWorldChanged = useCallback((event: { worldId?: unknown; instanceType?: unknown }) => {
    const worldId = typeof event?.worldId === 'string' ? event.worldId.trim() : ''
    if (!worldId) return
    setActiveWorldId(worldId)
    if (event?.instanceType === 'main_plaza') {
      mainPlazaWorldIdRef.current = worldId
    }
  }, [])

  const handlePlayerVoice = useCallback(({ id, muted }: { id: string; muted: boolean }) => {
    setRemotePlayers((prev) => {
      const next = new Map(prev)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, muted: !!muted })
      return next
    })
  }, [])

  const handlePlayerLeft = useCallback(({ id }: { id: string }) => {
    setRemotePlayers((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    // Keep token hot-swapped for future reconnect attempts.
    tokenRef.current = accessToken
    if (socketRef.current) {
      socketRef.current.auth = { token: accessToken }
      // Socket.IO auth middleware rejections do not always recover automatically.
      // If we were previously denied due to missing/stale token, retry with the fresh token.
      if (!socketRef.current.connected && accessToken.trim().length > 0) {
        socketRef.current.connect()
      }
    }
  }, [accessToken])

  useEffect(() => {
    // Lifecycle effect: create socket only when authenticated identity is ready.
    if (!canConnect) {
      socketRef.current?.disconnect()
      socketRef.current = null
      setSocket(null)
      setStatus('disconnected')
      setLastDisconnectReason(null)
      setLastError(null)
      setActiveWorldId(null)
      mainPlazaWorldIdRef.current = null
      lastPortalTransitionKeyRef.current = null
      clearWorldRuntimeState()
      return
    }

    const socketClient = io(SERVER_URL, { auth: { token: tokenRef.current } })
    setStatus('connecting')
    socketRef.current = socketClient
    setSocket(socketClient)

    const handleConnect = () => {
      // Fresh connect = reset transient state, then request authoritative spawn.
      setStatus('connected')
      setLastDisconnectReason(null)
      setLastError(null)
      setActiveWorldId(null)
      lastPortalTransitionKeyRef.current = null
      clearWorldRuntimeState()
      joinCurrentPlayer(socketClient)
    }

    const unbindHandlers = bindSocketEventHandlers(socketClient, {
      onConnect: handleConnect,
      onConnectError: handleConnectError,
      onDisconnect: handleDisconnect,
      onRoomState: handleRoomState,
      onPlayerJoined: handlePlayerJoined,
      onWorldSnapshot: handleWorldSnapshot,
      onWorldChanged: handleWorldChanged,
      onPlayerVoice: handlePlayerVoice,
      onPlayerLeft: handlePlayerLeft,
    })

    return () => {
      unbindHandlers()
      socketRef.current = null
      socketClient.disconnect()
    }
  }, [
    canConnect,
    clearWorldRuntimeState,
    handleConnectError,
    handleDisconnect,
    handlePlayerJoined,
    handlePlayerLeft,
    handlePlayerVoice,
    handleRoomState,
    handleWorldChanged,
    handleWorldSnapshot,
    joinCurrentPlayer,
  ]) // connect only when authenticated identity + token are ready

  useEffect(() => {
    const socketClient = socketRef.current
    if (!socketClient?.connected) return

    const localZoneKey = localAuthoritativeState?.zoneKey ?? null
    const mainPlazaWorldId = mainPlazaWorldIdRef.current
    if (!localZoneKey || !activeWorldId || !mainPlazaWorldId || activeWorldId !== mainPlazaWorldId) {
      lastPortalTransitionKeyRef.current = null
      return
    }

    if (localZoneKey !== 'dev' && localZoneKey !== 'design' && localZoneKey !== 'game') {
      lastPortalTransitionKeyRef.current = null
      return
    }

    const transitionKey = `${activeWorldId}:${localZoneKey}`
    if (lastPortalTransitionKeyRef.current === transitionKey) return
    lastPortalTransitionKeyRef.current = transitionKey

    socketClient.emit('world:change', { portalKey: localZoneKey }, (ack?: JoinAckPayload) => {
      if (ack?.error) {
        setLastError(String(ack.error))
        lastPortalTransitionKeyRef.current = null
        return
      }

      clearWorldRuntimeState()
      const spawn = parseSpawnFromJoinAck(ack)
      if (spawn) setServerSpawn(spawn)
      applyWorldAck(ack)
    })
  }, [activeWorldId, applyWorldAck, clearWorldRuntimeState, localAuthoritativeState?.zoneKey])

  /** Emit local movement input updates to the server at input cadence. */
  const emitInput = useCallback((state: PlayerInputState) => {
    socketRef.current?.emit('player:input', state)
  }, [])

  /** Emit local voice mute/unmute state to other players. */
  const emitVoiceState = useCallback((state: { muted: boolean }) => {
    socketRef.current?.emit('player:voice', state)
  }, [])

  return {
    socket,
    remotePlayers,
    serverSpawn,
    localAuthoritativeState,
    emitInput,
    emitVoiceState,
    activeWorldId,
    status,
    lastDisconnectReason,
    lastError,
  }
}
