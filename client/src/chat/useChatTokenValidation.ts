import { useMemo } from 'react'
import type { MentionSuggestion } from './types'

interface UseChatTokenValidationOptions {
  mentionSuggestions: MentionSuggestion[]
  commandTokens: string[]
  extraMentionTokens?: string[]
}

/**
 * Builds fast, case-insensitive token validators used by chat input UX.
 * Keeps lookups memoized so validation stays cheap while typing.
 */
export function useChatTokenValidation(options: UseChatTokenValidationOptions) {
  const { mentionSuggestions, commandTokens, extraMentionTokens = [] } = options

  // Includes both dynamic mention suggestions and optional static aliases.
  const validMentionTokens = useMemo(
    () => new Set([
      ...mentionSuggestions.map(item => item.token.toLowerCase()),
      ...extraMentionTokens.map(token => token.toLowerCase()),
    ]),
    [mentionSuggestions, extraMentionTokens],
  )

  const validCommandTokens = useMemo(
    () => new Set(commandTokens.map(token => token.toLowerCase())),
    [commandTokens],
  )

  // Maps typed text (without @) to a full mention suggestion.
  const mentionByNormalizedToken = useMemo(() => {
    const map = new Map<string, MentionSuggestion>()
    for (const suggestion of mentionSuggestions) {
      const token = suggestion.token.startsWith('@') ? suggestion.token.slice(1) : suggestion.token
      map.set(token.toLowerCase(), suggestion)
    }
    return map
  }, [mentionSuggestions])

  const isValidMentionToken = (token: string) => validMentionTokens.has(token.toLowerCase())
  const isValidCommandToken = (token: string) => validCommandTokens.has(token.toLowerCase())
  const getMentionByTypedToken = (typedWithoutAt: string) => mentionByNormalizedToken.get(typedWithoutAt.toLowerCase()) ?? null

  return {
    validMentionTokens,
    validCommandTokens,
    isValidMentionToken,
    isValidCommandToken,
    getMentionByTypedToken,
  }
}
