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
  const [spawnPosition, setSpawnPosition] = useState<{ x: number; y: number; z: number } | null>(null)

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
    const s = io(SERVER_URL, { auth: { token: tokenRef.current } })
    socketRef.current = s
    setSocket(s)

    s.on('connect', () => {
      s.emit('player:join', { name: playerRef.current.name, avatar: playerRef.current.avatar }, ({ position }: { position: { x: number; y: number; z: number } }) => {
        setSpawnPosition(position)
      })
    })

    s.on('room:state', (players: RemotePlayer[]) => {
      setRemotePlayers(new Map(players.map(p => [p.id, p])))
    })

    s.on('player:joined', (p: RemotePlayer) => {
      setRemotePlayers(prev => new Map(prev).set(p.id, p))
    })

    s.on('player:updated', ({ id, position, direction, moving }: Pick<RemotePlayer, 'direction' | 'moving'> & { id: string; position: RemotePlayer['position'] }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const p = next.get(id)
        if (p) next.set(id, { ...p, position, direction, moving })
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
      socketRef.current = null
      s.disconnect()
    }
  }, []) // connect once — player data is read from ref on 'connect'

  // Stable function reference — reads socket from ref, so LocalPlayer's
  // useFrame closure always calls the current socket without a prop re-capture.
  const emitMove = useCallback((state: { x: number; y: number; z: number; direction: string; moving: boolean }) => {
    socketRef.current?.emit('player:move', state)
  }, [])

  return { socket, remotePlayers, emitMove, spawnPosition }
}
