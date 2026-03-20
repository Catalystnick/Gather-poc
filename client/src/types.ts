// Shared domain types for the Gather PoC

export interface Avatar {
  shirt: string   // hex colour for shirt layer
  skirt: string   // hex colour for skirt/pants layer
}

export interface Player {
  name: string
  avatar: Avatar
}

export interface RemotePlayer {
  id: string
  name: string
  avatar: Avatar
  position: { x: number; y: number; z: number }
}

export interface ChatMessage {
  id: string
  name: string
  text: string
  timestamp: number
}
