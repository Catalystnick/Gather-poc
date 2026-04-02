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
  players: SnapshotPlayerPayload[]
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

/** Connect socket.io and expose synchronized multiplayer state/events. */
export function useSocket(player: Player, accessToken: string, userId: string) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())
  const [serverSpawn, setServerSpawn] = useState<{ col: number; row: number } | null>(null)
  const [localAuthoritativeState, setLocalAuthoritativeState] = useState<LocalAuthoritativeState | null>(null)
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

  useEffect(() => {
    tokenRef.current = accessToken
    if (socketRef.current) socketRef.current.auth = { token: accessToken }
  }, [accessToken])

  useEffect(() => {
    const socketClient = io(SERVER_URL, { auth: { token: tokenRef.current } })
    setStatus('connecting')
    socketRef.current = socketClient
    setSocket(socketClient)

    socketClient.on('connect', () => {
      setStatus('connected')
      setLastDisconnectReason(null)
      setLastError(null)
      setServerSpawn(null)
      setLocalAuthoritativeState(null)
      socketClient.emit(
        'player:join',
        { name: playerRef.current.name, avatar: playerRef.current.avatar },
        (ack?: { x?: unknown; y?: unknown; col?: unknown; row?: unknown; error?: unknown }) => {
          if (ack?.error) return
          const colFromAck = typeof ack?.col === 'number' ? ack.col : null
          const rowFromAck = typeof ack?.row === 'number' ? ack.row : null
          if (colFromAck !== null && rowFromAck !== null) {
            setServerSpawn({ col: colFromAck, row: rowFromAck })
            return
          }

          const x = typeof ack?.x === 'number' ? ack.x : null
          const y = typeof ack?.y === 'number' ? ack.y : null
          if (x === null || y === null) return
          setServerSpawn({
            col: Math.floor(x / TILE_PX),
            row: Math.floor(y / TILE_PX),
          })
        },
      )
    })

    socketClient.on('connect_error', (err) => {
      setStatus('error')
      setLastError(err?.message ?? String(err))
      setServerSpawn(null)
    })

    socketClient.on('disconnect', (reason) => {
      setStatus('disconnected')
      setLastDisconnectReason(String(reason))
      setServerSpawn(null)
      setLocalAuthoritativeState(null)
      setRemotePlayers(new Map())
    })

    socketClient.on('room:state', (players: SnapshotPlayerPayload[]) => {
      const snapshotTimeMs = performance.now()
      const serverTimeMs = Date.now()
      setRemotePlayers(
        new Map(
          players
            .filter((entry) => entry.id !== userId)
            .map((entry) => [entry.id, toRemotePlayer(entry, snapshotTimeMs, serverTimeMs)]),
        ),
      )
    })

    socketClient.on('player:joined', (joinedPlayer: SnapshotPlayerPayload) => {
      const snapshotTimeMs = performance.now()
      const serverTimeMs = Date.now()
      if (joinedPlayer.id === userId) return
      setRemotePlayers((prev) =>
        new Map(prev).set(
          joinedPlayer.id,
          toRemotePlayer(joinedPlayer, snapshotTimeMs, serverTimeMs),
        ),
      )
    })

    socketClient.on('world:snapshot', (snapshot: WorldSnapshotPayload) => {
      const snapshotTimeMs = performance.now()
      const nextRemote = new Map<string, RemotePlayer>()
      let nextLocal: LocalAuthoritativeState | null = null

      for (const playerState of snapshot.players ?? []) {
        const facing = facingOrDefault(playerState.facing)
        if (playerState.id === userId) {
          nextLocal = {
            x: playerState.x,
            y: playerState.y,
            vx: playerState.vx,
            vy: playerState.vy,
            facing,
            moving: !!playerState.moving,
            lastProcessedInputSeq: Number.isInteger(playerState.lastProcessedInputSeq)
              ? playerState.lastProcessedInputSeq
              : 0,
            serverTimeMs: Number.isFinite(snapshot.serverTimeMs)
              ? snapshot.serverTimeMs
              : Date.now(),
          }
          continue
        }

        nextRemote.set(
          playerState.id,
          toRemotePlayer(
            playerState,
            snapshotTimeMs,
            Number.isFinite(snapshot.serverTimeMs) ? snapshot.serverTimeMs : Date.now(),
          ),
        )
      }

      setLocalAuthoritativeState(nextLocal)
      setRemotePlayers(nextRemote)
    })

    socketClient.on('player:voice', ({ id, muted }: { id: string; muted: boolean }) => {
      setRemotePlayers((prev) => {
        const next = new Map(prev)
        const existing = next.get(id)
        if (existing) next.set(id, { ...existing, muted: !!muted })
        return next
      })
    })

    socketClient.on('player:left', ({ id }: { id: string }) => {
      setRemotePlayers((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    })

    return () => {
      socketRef.current = null
      socketClient.disconnect()
    }
  }, [userId]) // connect once per authenticated user

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
    status,
    lastDisconnectReason,
    lastError,
  }
}
