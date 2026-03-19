// Shared domain types for the Gather PoC

export interface Avatar {
  shape: 'capsule' | 'box' | 'sphere'
  color: string
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
