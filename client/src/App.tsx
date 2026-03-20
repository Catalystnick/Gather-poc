import { useState } from 'react'
import AvatarSelect from './components/AvatarSelect'
import World from './components/World'
import type { Player } from './types'

export type { Avatar, Player } from './types'

const STORAGE_KEY = 'gather_poc_avatar'

const SHAPES = new Set<Player['avatar']['shape']>(['swordsman', 'box', 'sphere'])

function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { name?: string; avatar?: { shape?: string; color?: string } }
    if (typeof p?.name !== 'string' || !p.avatar || typeof p.avatar.color !== 'string') return null
    let shape = p.avatar.shape === 'capsule' ? 'swordsman' : p.avatar.shape
    if (typeof shape !== 'string' || !SHAPES.has(shape as Player['avatar']['shape'])) return null
    return { name: p.name, avatar: { shape: shape as Player['avatar']['shape'], color: p.avatar.color } }
  } catch {
    return null
  }
}

export default function App() {
  const [player, setPlayer] = useState<Player | null>(null)

  function handleJoin(p: Player) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    setPlayer(p)
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />
  }

  return <World player={player} />
}
