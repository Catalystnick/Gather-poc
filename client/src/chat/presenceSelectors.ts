import type { RemotePlayer } from '../types'
import type { MentionSuggestion, OnlineUser } from './types'

/** Keeps mention tokens predictable across parsing and autocomplete. */
function sanitizeTokenName(name: string) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '')
}

/** Flattens current user + remote players into a chat user list. */
export function buildOnlineUsers(remotePlayers: Map<string, RemotePlayer>, currentUser: OnlineUser) {
  const users: OnlineUser[] = [currentUser]
  for (const player of remotePlayers.values()) {
    users.push({ id: player.id, name: player.name })
  }
  return users
}

/** Builds sorted mention suggestions and excludes the current user. */
export function buildMentionSuggestions(users: OnlineUser[], currentUserId: string): MentionSuggestion[] {
  return users
    .filter(user => user.id !== currentUserId)
    .map(user => {
      const safeName = sanitizeTokenName(user.name) || 'user'
      return {
        ...user,
        token: `@${safeName}`,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
