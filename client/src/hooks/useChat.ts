import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { ChatMessage } from '../types'
import { parseChatInput } from '../chat/commandParser'
import {
  maybeRequestNotificationPermission,
  showBrowserNotification,
  shouldNotifyHiddenTab,
} from '../chat/notificationService'
import type {
  CommandStatus,
  OnlineUser,
  TagIncoming,
  TeleportIncomingRequest,
} from '../chat/types'

const MAX_MESSAGES = 200

function appendMessage(prev: ChatMessage[], nextMessage: ChatMessage) {
  const next = [...prev, nextMessage]
  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
}

interface UseChatOptions {
  currentUserId: string
  onlineUsers: OnlineUser[]
}

/** Subscribe to chat stream and expose send helper + bounded message history. */
export function useChat(socket: Socket | null, options: UseChatOptions) {
  const { currentUserId, onlineUsers } = options
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [commandStatus, setCommandStatus] = useState<CommandStatus | null>(null)
  const [teleportRequests, setTeleportRequests] = useState<TeleportIncomingRequest[]>([])

  useEffect(() => {
    if (!socket) return

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages(prev => appendMessage(prev, msg))
    })

    socket.on('tag:incoming', (event: TagIncoming) => {
      setMessages(prev => appendMessage(prev, {
        id: `tag:${event.id}`,
        name: 'System',
        text: `${event.fromName} tagged you: ${event.message}`,
        timestamp: event.timestamp,
      }))

      const notificationKey = `tag:${event.id}`
      if (shouldNotifyHiddenTab(notificationKey)) {
        showBrowserNotification(`Tag from ${event.fromName}`, event.message)
      }
    })

    socket.on('teleport:incoming', (event: TeleportIncomingRequest) => {
      setTeleportRequests(prev => {
        const filtered = prev.filter(request => request.requestId !== event.requestId)
        return [event, ...filtered]
      })

      const notificationKey = `teleport:${event.requestId}`
      if (shouldNotifyHiddenTab(notificationKey)) {
        showBrowserNotification(`Teleport request from ${event.fromName}`, event.message)
      }
    })

    socket.on('teleport:result', (event: {
      requestId: string
      status: 'accepted' | 'declined' | 'failed'
      reason?: string
      targetName?: string
    }) => {
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
      socket.off('tag:incoming')
      socket.off('teleport:incoming')
      socket.off('teleport:result')
    }
  }, [socket])

  const sendMessage = useCallback((rawInput: string) => {
    if (!socket) return

    maybeRequestNotificationPermission()

    const parsed = parseChatInput(rawInput, onlineUsers, currentUserId)
    if (parsed.kind === 'error') {
      setCommandStatus({ kind: 'error', text: parsed.error })
      return
    }

    if (parsed.kind === 'plain') {
      socket.emit('chat:message', { text: parsed.text })
      setCommandStatus(null)
      return
    }

    if (parsed.kind === 'tag') {
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
  }, [socket, onlineUsers, currentUserId])

  const respondToTeleportRequest = useCallback((requestId: string, decision: 'accept' | 'decline') => {
    if (!socket) return

    socket.emit('teleport:respond', { requestId, decision }, (ack?: { ok?: boolean; error?: string }) => {
      if (!ack?.ok) {
        setCommandStatus({ kind: 'error', text: `Could not process teleport response: ${ack?.error ?? 'unknown'}` })
        return
      }

      setTeleportRequests(prev => prev.filter(request => request.requestId !== requestId))
      setCommandStatus({ kind: 'info', text: decision === 'accept' ? 'Teleport accepted.' : 'Teleport declined.' })
    })
  }, [socket])

  const clearCommandStatus = useCallback(() => {
    setCommandStatus(null)
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
    teleportRequests,
    respondToTeleportRequest,
  }
}
