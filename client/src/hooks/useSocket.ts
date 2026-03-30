import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Player, RemotePlayer } from '../types'

// VITE_SERVER_URL overrides for deployed builds (e.g. Netlify → Render/Railway server).
// Otherwise connect to current origin — Vite proxies /socket.io to the backend,
// avoiding mixed-content errors when the page is served over HTTPS.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined

/** Connect socket.io and expose synchronized multiplayer state/events. */
export function useSocket(player: Player, accessToken: string) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())
  const [serverSpawn, setServerSpawn] = useState<{ col: number; row: number } | null>(null)
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
    if (socketRef.current) {
      socketRef.current.auth = { token: accessToken }
    }
  }, [accessToken])

  useEffect(() => {
    console.log('[socket] connecting to', SERVER_URL ?? 'current origin', '| token present:', !!tokenRef.current, '| token length:', tokenRef.current?.length)
    const socketClient = io(SERVER_URL, { auth: { token: tokenRef.current } })
    setStatus('connecting')
    socketRef.current = socketClient
    setSocket(socketClient)

    socketClient.on('connect', () => {
      console.log('[socket] connected | id:', socketClient.id)
      setStatus('connected')
      setLastDisconnectReason(null)
      setLastError(null)
      setServerSpawn(null)
      console.log('[socket] emitting player:join | name:', playerRef.current.name)
      socketClient.emit(
        'player:join',
        { name: playerRef.current.name, avatar: playerRef.current.avatar },
        (ack?: { col?: unknown; row?: unknown; error?: unknown }) => {
          if (ack?.error) {
            console.error('[socket] player:join rejected by server:', ack.error)
            return
          }
          const col = typeof ack?.col === 'number' ? ack.col : null
          const row = typeof ack?.row === 'number' ? ack.row : null
          if (col === null || row === null) {
            console.warn('[socket] player:join ack missing spawn payload', ack)
            return
          }
          console.log('[socket] server spawn ack | col:', col, 'row:', row)
          setServerSpawn({ col, row })
        },
      )
    })

    socketClient.on('connect_error', (err) => {
      console.error('[socket] connect_error:', err.message)
      setStatus('error')
      setLastError(err?.message ?? String(err))
      setServerSpawn(null)
    })

    socketClient.on('disconnect', (reason) => {
      console.warn('[socket] disconnected | reason:', reason)
      setStatus('disconnected')
      setLastDisconnectReason(String(reason))
      setServerSpawn(null)
    })

    socketClient.on('room:state', (players: RemotePlayer[]) => {
      console.log('[socket] room:state | remote players:', players.length)
      setRemotePlayers(
        new Map(
          players.map(remotePlayer => [
            remotePlayer.id,
            { ...remotePlayer, zoneKey: remotePlayer.zoneKey ?? null, muted: !!remotePlayer.muted },
          ]),
        ),
      )
    })

    socketClient.on('player:joined', (joinedPlayer: RemotePlayer) => {
      setRemotePlayers(prev => new Map(prev).set(joinedPlayer.id, { ...joinedPlayer, zoneKey: joinedPlayer.zoneKey ?? null, muted: !!joinedPlayer.muted }))
    })

    socketClient.on('player:updated', ({ id, col, row, direction, moving, zoneKey }: Pick<RemotePlayer, 'col' | 'row' | 'direction' | 'moving' | 'zoneKey'> & { id: string }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const existingPlayer = next.get(id)
        if (existingPlayer) next.set(id, { ...existingPlayer, col, row, direction, moving, zoneKey: zoneKey ?? null })
        return next
      })
    })

    socketClient.on('player:teleported', (teleportedPlayer: RemotePlayer) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const existingPlayer = next.get(teleportedPlayer.id)
        if (existingPlayer) {
          next.set(teleportedPlayer.id, {
            ...existingPlayer,
            col: teleportedPlayer.col,
            row: teleportedPlayer.row,
            direction: teleportedPlayer.direction,
            moving: !!teleportedPlayer.moving,
            zoneKey: teleportedPlayer.zoneKey ?? null,
            muted: !!teleportedPlayer.muted,
          })
          return next
        }

        next.set(teleportedPlayer.id, {
          ...teleportedPlayer,
          zoneKey: teleportedPlayer.zoneKey ?? null,
          muted: !!teleportedPlayer.muted,
        })
        return next
      })
    })

    socketClient.on('player:voice', ({ id, muted }: { id: string; muted: boolean }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const existingPlayer = next.get(id)
        if (existingPlayer) next.set(id, { ...existingPlayer, muted: !!muted })
        return next
      })
    })

    socketClient.on('player:left', ({ id }: { id: string }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    })

    return () => {
      console.log('[socket] cleanup — disconnecting')
      socketRef.current = null
      socketClient.disconnect()
    }
  }, []) // connect once — player data is read from ref on 'connect'

  // Stable function reference — reads socket from ref, so LocalPlayer's
  // useFrame closure always calls the current socket without a prop re-capture.
  /** Emit local movement updates to the server. */
  const emitMove = useCallback((state: { col: number; row: number; direction: string; moving: boolean; zoneKey: string | null }) => {
    socketRef.current?.emit('player:move', state)
  }, [])

  /** Emit local voice mute/unmute state to other players. */
  const emitVoiceState = useCallback((state: { muted: boolean }) => {
    socketRef.current?.emit('player:voice', state)
  }, [])

  return {
    socket,
    remotePlayers,
    serverSpawn,
    emitMove,
    emitVoiceState,
    status,
    lastDisconnectReason,
    lastError,
  }
}
