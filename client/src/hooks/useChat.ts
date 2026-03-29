import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { ChatMessage } from '../types'

const MAX_MESSAGES = 200

/** Subscribe to chat stream and expose send helper + bounded message history. */
export function useChat(socket: Socket | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])

  useEffect(() => {
    if (!socket) return

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages(prev => {
        const next = [...prev, msg]
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
      })
    })

    return () => { socket.off('chat:message') }
  }, [socket])

  // Closes over socket from state — no need to pass it as a parameter.
  const sendMessage = useCallback((text: string) => {
    socket?.emit('chat:message', { text })
  }, [socket])

  return { messages, sendMessage }
}
