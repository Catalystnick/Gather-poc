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
  x: number
  y: number
  vx: number
  vy: number
  col: number
  row: number
  worldX: number
  worldY: number
  direction: Direction
  moving: boolean
  lastProcessedInputSeq: number
  snapshotTimeMs: number
  serverTimeMs: number
  zoneKey: string | null
  muted: boolean
}

export interface PlayerInputState {
  seq: number
  inputX: number
  inputY: number
  facing: Direction
  moving: boolean
  clientTimeMs: number
}

export interface LocalAuthoritativeState {
  x: number
  y: number
  vx: number
  vy: number
  facing: Direction
  moving: boolean
  lastProcessedInputSeq: number
  serverTimeMs: number
  zoneKey: string | null
}

export interface ChatMention {
  userId: string
  token: string
}

export interface ChatMessage {
  id: string
  name: string
  text: string
  body?: string
  mentions?: ChatMention[]
  timestamp: number
}
