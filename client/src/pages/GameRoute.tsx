import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import AvatarSelect from '../components/ui/AvatarSelect'
import World from '../components/scene/World'
import type { Player } from '../types'

const STORAGE_KEY = 'gather_poc_avatar'

function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { name?: string; avatar?: { shirt?: string } }
    if (typeof p?.name !== 'string' || typeof p?.avatar?.shirt !== 'string') return null
    return { name: p.name, avatar: { shirt: p.avatar.shirt } }
  } catch {
    return null
  }
}

export default function GameRoute() {
  const { isAuthenticated, isLoading } = useAuth()
  const [player, setPlayer] = useState<Player | null>(null)

  if (isLoading) return null

  if (!isAuthenticated) return <Navigate to="/login" replace />

  function handleJoin(p: Player) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    setPlayer(p)
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />
  }

  return <World player={player} />
}
