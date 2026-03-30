import type { OnlineUser, ParsedInput } from './types'

type ExtractTargetsResult =
  | { targetUserIds: string[]; message: string }
  | { error: string }

function sanitizeTokenName(name: string) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '')
}

function resolveTargetToken(token: string, onlineUsers: OnlineUser[]): string | null {
  if (!token.startsWith('@')) return null
  const value = token.slice(1)
  if (!value) return null

  const normalized = value.toLowerCase()
  const matches = onlineUsers.filter(
    user => sanitizeTokenName(user.name).toLowerCase() === normalized,
  )
  if (matches.length === 1) return matches[0].id

  return null
}

function extractTargetsAndMessage(
  tokens: string[],
  onlineUsers: OnlineUser[],
  currentUserId: string,
): ExtractTargetsResult {
  const targetUserIds: string[] = []
  let messageStartIndex = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('@')) {
      messageStartIndex = index
      break
    }

    const targetId = resolveTargetToken(token, onlineUsers)
    if (!targetId) {
      return { error: `Unknown user token: ${token}` }
    }

    if (targetId === currentUserId) {
      return { error: 'You cannot target yourself.' }
    }

    if (!targetUserIds.includes(targetId)) {
      targetUserIds.push(targetId)
    }

    messageStartIndex = index + 1
  }

  const message = tokens.slice(messageStartIndex).join(' ').trim()
  if (!targetUserIds.length) return { error: 'Add at least one @user target.' }
  if (!message) return { error: 'Add a message after the user list.' }

  return { targetUserIds, message }
}

export function parseChatInput(rawInput: string, onlineUsers: OnlineUser[], currentUserId: string): ParsedInput {
  if (!rawInput.trim()) return { kind: 'error', error: 'Message cannot be empty.' }

  if (rawInput.startsWith('@tag ')) {
    const tokens = rawInput.trim().split(/\s+/)
    const extracted = extractTargetsAndMessage(tokens.slice(1), onlineUsers, currentUserId)
    if ('error' in extracted) return { kind: 'error', error: extracted.error }
    return {
      kind: 'tag',
      payload: extracted,
    }
  }

  if (rawInput.startsWith('/')) {
    const tokens = rawInput.trim().split(/\s+/)
    const command = tokens[0].toLowerCase()

    if (command !== '/teleport') {
      return { kind: 'error', error: `Unknown command: ${tokens[0]}` }
    }

    const extracted = extractTargetsAndMessage(tokens.slice(1), onlineUsers, currentUserId)
    if ('error' in extracted) return { kind: 'error', error: extracted.error }

    return {
      kind: 'teleport',
      payload: extracted,
    }
  }

  return { kind: 'plain', text: rawInput.trim() }
}
