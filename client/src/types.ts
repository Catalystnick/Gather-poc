// Shared domain types for the Gather PoC

export type Direction = 'down' | 'up' | 'right' | 'left'

export interface Avatar {
  shirt: string   // hex colour for shirt layer
}

export interface Player {
  name: string
  avatar: Avatar
}

export interface RemotePlayer {
  id: string
  name: string
  avatar: Avatar
  col: number
  row: number
  direction: Direction
  moving: boolean
  zoneKey: string | null
}

export interface ChatMessage {
  id: string
  name: string
  text: string
  timestamp: number
}
