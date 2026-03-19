import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Avatar, Player } from '../App'

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'

export interface RemotePlayer {
  id: string
  name: string
  avatar: Avatar
  position: { x: number; y: number; z: number }
}

export function useSocket(player: Player) {
  const socketRef = useRef<Socket | null>(null)
  const [remotePlayers, setRemotePlayers] = useState<Map<string, RemotePlayer>>(new Map())

  useEffect(() => {
    const socket = io(SERVER_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('player:join', { name: player.name, avatar: player.avatar })
    })

    socket.on('room:state', (players: RemotePlayer[]) => {
      setRemotePlayers(new Map(players.map(p => [p.id, p])))
    })

    socket.on('player:joined', (p: RemotePlayer) => {
      setRemotePlayers(prev => new Map(prev).set(p.id, p))
    })

    socket.on('player:updated', ({ id, position }: { id: string; position: RemotePlayer['position'] }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        const p = next.get(id)
        if (p) next.set(id, { ...p, position })
        return next
      })
    })

    socket.on('player:left', ({ id }: { id: string }) => {
      setRemotePlayers(prev => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    })

    return () => { socket.disconnect() }
  }, [player.name, player.avatar])

  function emitMove(position: { x: number; y: number; z: number }) {
    socketRef.current?.emit('player:move', position)
  }

  return { remotePlayers, emitMove }
}
