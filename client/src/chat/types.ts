export interface OnlineUser {
  id: string
  name: string
}

export interface CommandStatus {
  kind: 'success' | 'error' | 'info'
  text: string
}

export interface TagIncoming {
  id: string
  fromUserId: string
  fromName: string
  message: string
  timestamp: number
}

export interface TeleportIncomingRequest {
  requestId: string
  fromUserId: string
  fromName: string
  message: string
  timestamp: number
}

export interface TagCommandPayload {
  targetUserIds: string[]
  message: string
}

export interface TeleportCommandPayload {
  targetUserIds: string[]
  message: string
}

export interface MentionSuggestion extends OnlineUser {
  token: string
}

export type ParsedInput =
  | { kind: 'plain'; text: string }
  | { kind: 'tag'; payload: TagCommandPayload }
  | { kind: 'teleport'; payload: TeleportCommandPayload }
  | { kind: 'error'; error: string }
