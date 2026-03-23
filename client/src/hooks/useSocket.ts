import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Player } from '../types'

// VITE_SERVER_URL overrides for deployed builds (e.g. Netlify → Render/Railway server).
// Otherwise connect to current origin — Vite proxies /socket.io to the backend,
// avoiding mixed-content errors when the page is served over HTTPS.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined

export function useSocket(player: Player) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())

  // Keep a stable ref to the latest player data so the connect handler
  // always sends the current name/avatar without triggering a reconnect.
  const playerRef = useRef(player)
  playerRef.current = player

  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    const s = io(SERVER_URL)
    socketRef.current = s
    setSocket(s)

    s.on('connect', () => {
      s.emit('player:join', { name: playerRef.current.name, avatar: playerRef.current.avatar })
    })

    s.on('room:state', (players: RemotePlayer[]) => {
      setRemotePlayers(new Map(players.map(p => [p.id, p])))
    })

    s.on('player:joined', (p: RemotePlayer) => {
      setRemotePlayers(prev => new Map(prev).set(p.id, p))
    })

    s.on('player:updated', ({ id, position }: { id: string; position: RemotePlayer['position'] }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const p = next.get(id)
        if (p) next.set(id, { ...p, position })
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
  const emitMove = useCallback((position: { x: number; y: number; z: number }) => {
    socketRef.current?.emit('player:move', position)
  }, [])

  return { socket, remotePlayers, emitMove }
}
