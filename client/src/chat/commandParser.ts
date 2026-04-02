import type { ChatMention } from '../types'
import type { OnlineUser, ParsedInput } from './types'

type ExtractTargetsResult =
  | { targetUserIds: string[]; message: string }
  | { error: string }

function isMentionToken(token: string) {
  return /^@[A-Za-z0-9_\-]+$/.test(token)
}

function sanitizeTokenName(name: string) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '')
}

function resolveTargetToken(token: string, onlineUsers: OnlineUser[]): OnlineUser | null {
  if (!token.startsWith('@')) return null
  const value = token.slice(1)
  if (!value) return null

  const normalized = value.toLowerCase()
  const matches = onlineUsers.filter(
    user => sanitizeTokenName(user.name).toLowerCase() === normalized,
  )
  if (matches.length === 1) return matches[0]

  return null
}

function tokenForUserName(name: string) {
  const safeName = sanitizeTokenName(name)
  return `@${safeName || 'user'}`
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

    const targetUser = resolveTargetToken(token, onlineUsers)
    if (!targetUser) {
      return { error: `Unknown user token: ${token}` }
    }
    const targetId = targetUser.id

    if (targetId === currentUserId) {
      return { error: 'You cannot target yourself.' }
    }

    if (!targetUserIds.includes(targetId)) {
      targetUserIds.push(targetId)
    }

    messageStartIndex = index + 1
  }

  // Mention tags in the free-text portion are metadata, not message body.
  // They should not satisfy the "message present" requirement by themselves.
  const message = tokens
    .slice(messageStartIndex)
    .filter(token => !isMentionToken(token))
    .join(' ')
    .trim()
  if (!targetUserIds.length) return { error: 'Add at least one @user target.' }
  if (!message) return { error: 'Add a message after the user list.' }

  return { targetUserIds, message }
}

function extractPlainBodyAndMentions(tokens: string[], onlineUsers: OnlineUser[]): {
  body: string
  mentions: ChatMention[]
} {
  const mentions: ChatMention[] = []
  const seenMentionUserIds = new Set<string>()
  const bodyTokens: string[] = []

  for (const token of tokens) {
    if (token.startsWith('@')) {
      const targetUser = resolveTargetToken(token, onlineUsers)
      if (targetUser) {
        if (!seenMentionUserIds.has(targetUser.id)) {
          mentions.push({
            userId: targetUser.id,
            token: tokenForUserName(targetUser.name),
          })
          seenMentionUserIds.add(targetUser.id)
        }
        continue
      }
    }

    bodyTokens.push(token)
  }

  return {
    body: bodyTokens.join(' ').trim(),
    mentions,
  }
}

export function parseChatInput(rawInput: string, onlineUsers: OnlineUser[], currentUserId: string): ParsedInput {
  if (!rawInput.trim()) return { kind: 'error', error: 'Message cannot be empty.' }

  const trimmed = rawInput.trim()
  const lower = trimmed.toLowerCase()

  if (lower === '@tag' || lower.startsWith('@tag ')) {
    const tokens = trimmed.split(/\s+/)
    const extracted = extractTargetsAndMessage(tokens.slice(1), onlineUsers, currentUserId)
    if ('error' in extracted) return { kind: 'error', error: extracted.error }
    return {
      kind: 'tag',
      payload: extracted,
    }
  }

  if (trimmed.startsWith('/')) {
    const tokens = trimmed.split(/\s+/)
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

  const tokens = trimmed.split(/\s+/)
  const { body, mentions } = extractPlainBodyAndMentions(tokens, onlineUsers)

  if (!body) {
    return { kind: 'error', error: 'Message cannot be empty.' }
  }

  return { kind: 'plain', text: trimmed, body, mentions }
}
