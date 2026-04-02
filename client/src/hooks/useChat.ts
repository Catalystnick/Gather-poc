import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { ChatMessage } from '../types'
import { parseChatInput } from '../chat/commandParser'
import {
  ensureNotificationPermissionOnUserGesture,
  getNotificationDebugState,
  maybeRequestNotificationPermission,
  playTagSound,
  showBrowserNotification,
  shouldNotifyAnyVisibility,
  shouldNotifyHiddenTab,
} from '../chat/notificationService'
import type {
  CommandStatus,
  OnlineUser,
  TagIncoming,
  TeleportIncomingRequest,
} from '../chat/types'

const MAX_MESSAGES = 200
const STALE_TELEPORT_RESPONSE_ERRORS = new Set(['not_found', 'sender_offline', 'forbidden'])

function appendMessage(prev: ChatMessage[], nextMessage: ChatMessage) {
  const next = [...prev, nextMessage]
  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
}

function sanitizeTokenName(name: string) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '')
}

function tokenForUserName(name: string) {
  const safe = sanitizeTokenName(name)
  return safe ? `@${safe}` : '@user'
}

function extractMentionTokens(text: string) {
  const matches = text.match(/@[A-Za-z0-9_\-]+/g)
  if (!matches) return []
  return matches.map(token => token.toLowerCase())
}

interface UseChatOptions {
  currentUserId: string
  onlineUsers: OnlineUser[]
}

/** Subscribe to chat stream and expose send helper + bounded message history. */
export function useChat(socket: Socket | null, options: UseChatOptions) {
  const { currentUserId, onlineUsers } = options
  const currentUserName = onlineUsers.find(user => user.id === currentUserId)?.name ?? 'You'
  const currentUserToken = tokenForUserName(currentUserName).toLowerCase()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [commandStatus, setCommandStatus] = useState<CommandStatus | null>(null)
  const [teleportRequests, setTeleportRequests] = useState<TeleportIncomingRequest[]>([])
  const [tagPings, setTagPings] = useState<TagIncoming[]>([])

  useEffect(() => {
    if (!socket) return
    ensureNotificationPermissionOnUserGesture()

    socket.on('chat:message', (msg: ChatMessage) => {
      const normalizedBody = typeof msg.body === 'string' ? msg.body : msg.text
      const normalizedMentions = Array.isArray(msg.mentions) ? msg.mentions : []
      const normalizedMessage: ChatMessage = {
        ...msg,
        body: normalizedBody,
        mentions: normalizedMentions,
        text: normalizedBody,
      }
      setMessages(prev => appendMessage(prev, normalizedMessage))

      const mentionTokens = normalizedMentions.length
        ? normalizedMentions.map(mention => mention.token.toLowerCase())
        : extractMentionTokens(normalizedMessage.text)
      const mentionedByUserId = normalizedMentions.some(mention => mention.userId === currentUserId)
      const mentionedCurrentUser =
        normalizedMessage.id !== currentUserId
        && (mentionedByUserId || mentionTokens.includes(currentUserToken))

      if (!mentionedCurrentUser) {
        console.log('[notify][mention] skipped mention sound/notification', {
          fromUserId: normalizedMessage.id,
          currentUserId,
          mentionedByUserId,
          mentionTokens,
          currentUserToken,
        })
        return
      }

      console.log('[notify][mention] invoking playTagSound()', {
        fromUserId: normalizedMessage.id,
        fromName: normalizedMessage.name,
      })
      playTagSound()

      const notificationKey = `mention:${normalizedMessage.id}:${normalizedMessage.timestamp}:${currentUserToken}`
      const shouldNotify = shouldNotifyAnyVisibility(notificationKey)
      console.log('[notify][mention] chat mention detected:', {
        notificationKey,
        fromUserId: normalizedMessage.id,
        fromName: normalizedMessage.name,
        mentionedToken: currentUserToken,
        mentionTokens,
        shouldNotify,
      })
      if (shouldNotify) {
        void showBrowserNotification(
          `Mention from ${normalizedMessage.name}`,
          normalizedMessage.body ?? normalizedMessage.text,
        ).then((shown) => {
          console.log('[notify][mention] dispatch result:', {
            notificationKey,
            shown,
            debug: getNotificationDebugState(),
          })
        })
      } else {
        console.log('[notify][mention] skipped notification dispatch')
      }
    })

    socket.on('chat:rate_limited', (event: { retryAfterMs?: number }) => {
      const retryAfterMs = typeof event?.retryAfterMs === 'number' ? event.retryAfterMs : 0
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
      setCommandStatus({
        kind: 'error',
        text: `You're sending messages too quickly. Try again in about ${retryAfterSeconds}s.`,
      })
    })

    socket.on('tag:incoming', (event: TagIncoming) => {
      console.log('[tag] incoming:', event)
      console.log('[notify][tag] incoming event:', {
        tagId: event.id,
        fromUserId: event.fromUserId,
        fromName: event.fromName,
        debug: getNotificationDebugState(),
      })
      setMessages(prev => appendMessage(prev, {
        id: `tag:${event.id}`,
        name: 'System',
        text: `@tag ${tokenForUserName(event.fromName)} ${event.message}`,
        timestamp: event.timestamp,
      }))
      setTagPings(prev => [event, ...prev.filter(item => item.id !== event.id)].slice(0, 5))
      window.setTimeout(() => {
        setTagPings(prev => prev.filter(item => item.id !== event.id))
      }, 8000)
      console.log('[notify][tag] invoking playTagSound()', { tagId: event.id })
      playTagSound()
      console.log('[notify][tag] playTagSound() call completed', { tagId: event.id })

      const notificationKey = `tag:${event.id}`
      const shouldNotify = shouldNotifyAnyVisibility(notificationKey)
      console.log('[notify][tag] gate decision:', {
        notificationKey,
        shouldNotify,
        debug: getNotificationDebugState(),
      })
      if (shouldNotify) {
        void showBrowserNotification(`Tag from ${event.fromName}`, event.message).then((shown) => {
          console.log('[notify][tag] dispatch result:', {
            notificationKey,
            shown,
            debug: getNotificationDebugState(),
          })
        })
      } else {
        console.log('[notify][tag] skipped notification dispatch')
      }
    })

    socket.on('teleport:incoming', (event: TeleportIncomingRequest) => {
      setTeleportRequests(prev => {
        const filtered = prev.filter(request => request.requestId !== event.requestId)
        return [event, ...filtered]
      })

      const notificationKey = `teleport:${event.requestId}`
      if (shouldNotifyHiddenTab(notificationKey)) {
        void showBrowserNotification(`Teleport request from ${event.fromName}`, event.message)
      }
    })

    socket.on('teleport:request_cleared', (event: { requestId: string; reason?: string }) => {
      if (!event?.requestId) return
      setTeleportRequests(prev => prev.filter(request => request.requestId !== event.requestId))
      if (event.reason === 'sender_disconnected') {
        setCommandStatus({ kind: 'info', text: 'Teleport request expired because the requester disconnected.' })
      }
    })

    socket.on('teleport:result', (event: {
      requestId: string
      status: 'accepted' | 'declined' | 'failed'
      reason?: string
      targetName?: string
    }) => {
      if (event.requestId) {
        setTeleportRequests(prev => prev.filter(request => request.requestId !== event.requestId))
      }
      if (event.status === 'accepted') {
        setCommandStatus({ kind: 'success', text: 'Teleport accepted.' })
      } else if (event.status === 'declined') {
        setCommandStatus({ kind: 'info', text: `${event.targetName ?? 'User'} declined the teleport request.` })
      } else {
        setCommandStatus({ kind: 'error', text: `Teleport request failed: ${event.reason ?? 'unknown'}` })
      }
    })

    return () => {
      socket.off('chat:message')
      socket.off('chat:rate_limited')
      socket.off('tag:incoming')
      socket.off('teleport:incoming')
      socket.off('teleport:request_cleared')
      socket.off('teleport:result')
    }
  }, [socket, currentUserId, currentUserToken])

  const sendMessage = useCallback((rawInput: string) => {
    if (!socket) return

    maybeRequestNotificationPermission()
    console.log('[chat] send input:', rawInput)

    const parsed = parseChatInput(rawInput, onlineUsers, currentUserId)
    console.log('[chat] parsed input:', parsed)
    if (parsed.kind === 'error') {
      setCommandStatus({ kind: 'error', text: parsed.error })
      return
    }

    if (parsed.kind === 'plain') {
      const lower = parsed.body.toLowerCase()
      if (lower === '@tag' || lower.startsWith('@tag ')) {
        setCommandStatus({ kind: 'error', text: 'Add at least one @user and a message for @tag.' })
        return
      }

      socket.emit('chat:message', {
        body: parsed.body,
        mentions: parsed.mentions,
      })
      setCommandStatus(null)
      return
    }

    if (parsed.kind === 'tag') {
      if (!parsed.payload.message.trim()) {
        setCommandStatus({ kind: 'error', text: 'Tag message cannot be empty.' })
        return
      }

      socket.emit('tag:send', parsed.payload, (ack?: {
        ok?: boolean
        sent?: { name: string }[]
        rejected?: { userId: string; reason: string }[]
        error?: string
      }) => {
        if (!ack?.ok) {
          const reason = ack?.error ?? 'tag_failed'
          setCommandStatus({ kind: 'error', text: `Tag failed: ${reason}` })
          return
        }

        const targetTokens = parsed.payload.targetUserIds
          .map((targetUserId) => {
            const user = onlineUsers.find(candidate => candidate.id === targetUserId)
            return user ? tokenForUserName(user.name) : null
          })
          .filter((token): token is string => !!token)
        const targetText = targetTokens.join(' ')
        const tagHistoryText = targetText
          ? `@tag ${targetText} ${parsed.payload.message}`
          : `@tag ${parsed.payload.message}`
        setMessages(prev => appendMessage(prev, {
          id: `tag:outgoing:${Date.now()}`,
          name: currentUserName,
          text: tagHistoryText,
          timestamp: Date.now(),
        }))

        const sentCount = ack.sent?.length ?? 0
        const rejectedCount = ack.rejected?.length ?? 0
        setCommandStatus({
          kind: 'success',
          text: `Tag sent to ${sentCount} user(s)${rejectedCount ? ` (${rejectedCount} rejected)` : ''}.`,
        })
      })
      return
    }

    socket.emit('teleport:request', parsed.payload, (ack?: {
      ok?: boolean
      sent?: { userId: string }[]
      cooldown?: { userId: string }[]
      rejected?: { userId: string; reason: string }[]
      error?: string
    }) => {
      if (!ack?.ok) {
        const reason = ack?.error ?? 'teleport_failed'
        setCommandStatus({ kind: 'error', text: `Teleport request failed: ${reason}` })
        return
      }

      const sentCount = ack.sent?.length ?? 0
      const cooldownCount = ack.cooldown?.length ?? 0
      const rejectedCount = ack.rejected?.length ?? 0
      setCommandStatus({
        kind: 'success',
        text: `Teleport request sent to ${sentCount} user(s).${cooldownCount ? ` ${cooldownCount} cooling down.` : ''}${rejectedCount ? ` ${rejectedCount} rejected.` : ''}`,
      })
    })
  }, [socket, onlineUsers, currentUserId, currentUserName])

  const respondToTeleportRequest = useCallback((requestId: string, decision: 'accept' | 'decline') => {
    if (!socket) return

    socket.emit('teleport:respond', { requestId, decision }, (ack?: { ok?: boolean; error?: string }) => {
      if (!ack?.ok) {
        setTeleportRequests(prev => prev.filter(request => request.requestId !== requestId))
        const errorCode = ack?.error ?? 'unknown'
        if (STALE_TELEPORT_RESPONSE_ERRORS.has(errorCode)) {
          setCommandStatus({ kind: 'info', text: 'Teleport request is no longer active.' })
        } else {
          setCommandStatus({ kind: 'error', text: `Could not process teleport response: ${errorCode}` })
        }
        return
      }

      setTeleportRequests(prev => prev.filter(request => request.requestId !== requestId))
      setCommandStatus({ kind: 'info', text: decision === 'accept' ? 'Teleport accepted.' : 'Teleport declined.' })
    })
  }, [socket])

  const clearCommandStatus = useCallback(() => {
    setCommandStatus(null)
  }, [])

  const dismissTagPing = useCallback((id: string) => {
    setTagPings(prev => prev.filter(item => item.id !== id))
  }, [])

  useEffect(() => {
    if (!commandStatus) return
    const timer = window.setTimeout(() => setCommandStatus(null), 4500)
    return () => window.clearTimeout(timer)
  }, [commandStatus])

  return {
    messages,
    sendMessage,
    commandStatus,
    clearCommandStatus,
    tagPings,
    dismissTagPing,
    teleportRequests,
    respondToTeleportRequest,
  }
}
