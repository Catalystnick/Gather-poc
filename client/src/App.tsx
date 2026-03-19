import { useState } from 'react'
import AvatarSelect from './components/AvatarSelect'
import World from './components/World'
import type { Player } from './types'

export type { Avatar, Player } from './types'

const STORAGE_KEY = 'gather_poc_avatar'

function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
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
