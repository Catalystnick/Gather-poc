import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Player, RemotePlayer } from '../types'

// VITE_SERVER_URL overrides for deployed builds (e.g. Netlify → Render/Railway server).
// Otherwise connect to current origin — Vite proxies /socket.io to the backend,
// avoiding mixed-content errors when the page is served over HTTPS.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined

export function useSocket(player: Player, accessToken: string) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())
  const [spawnPosition, setSpawnPosition] = useState<{ col: number; row: number } | null>(null)
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
    const s = io(SERVER_URL, { auth: { token: tokenRef.current } })
    setStatus('connecting')
    socketRef.current = s
    setSocket(s)

    s.on('connect', () => {
      console.log('[socket] connected | id:', s.id)
      setStatus('connected')
      setLastDisconnectReason(null)
      setLastError(null)
      console.log('[socket] emitting player:join | name:', playerRef.current.name)
      s.emit('player:join', { name: playerRef.current.name, avatar: playerRef.current.avatar }, ({ col, row }: { col: number; row: number }) => {
        console.log('[socket] player:join ack received | spawnTile:', { col, row })
        setSpawnPosition({ col, row })
      })
    })

    s.on('connect_error', (err) => {
      console.error('[socket] connect_error:', err.message)
      setStatus('error')
      setLastError(err?.message ?? String(err))
    })

    s.on('disconnect', (reason) => {
      console.warn('[socket] disconnected | reason:', reason)
      setStatus('disconnected')
      setLastDisconnectReason(String(reason))
    })

    s.on('room:state', (players: RemotePlayer[]) => {
      console.log('[socket] room:state | remote players:', players.length)
      setRemotePlayers(new Map(players.map(p => [p.id, { ...p, zoneKey: p.zoneKey ?? null }])))
    })

    s.on('player:joined', (p: RemotePlayer) => {
      setRemotePlayers(prev => new Map(prev).set(p.id, { ...p, zoneKey: p.zoneKey ?? null }))
    })

    s.on('player:updated', ({ id, col, row, direction, moving, zoneKey }: Pick<RemotePlayer, 'col' | 'row' | 'direction' | 'moving' | 'zoneKey'> & { id: string }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const p = next.get(id)
        if (p) next.set(id, { ...p, col, row, direction, moving, zoneKey: zoneKey ?? null })
        return next
      })
    })

    s.on('player:left', ({ id }: { id: string }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    })

    return () => {
      console.log('[socket] cleanup — disconnecting')
      socketRef.current = null
      s.disconnect()
    }
  }, []) // connect once — player data is read from ref on 'connect'

  // Stable function reference — reads socket from ref, so LocalPlayer's
  // useFrame closure always calls the current socket without a prop re-capture.
  const emitMove = useCallback((state: { col: number; row: number; direction: string; moving: boolean; zoneKey: string | null }) => {
    socketRef.current?.emit('player:move', state)
  }, [])

  return { socket, remotePlayers, emitMove, spawnPosition, status, lastDisconnectReason, lastError }
}
