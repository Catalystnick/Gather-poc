import { useState } from 'react'
import AvatarSelect from './components/AvatarSelect'
import World from './components/World'
import type { Player } from './types'

export type { Avatar, Player } from './types'

const STORAGE_KEY = 'gather_poc_avatar'

function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { name?: string; avatar?: { shirt?: string; skirt?: string } }
    if (
      typeof p?.name !== 'string' ||
      typeof p?.avatar?.shirt !== 'string' ||
      typeof p?.avatar?.skirt !== 'string'
    ) return null
    return { name: p.name, avatar: { shirt: p.avatar.shirt, skirt: p.avatar.skirt } }
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
