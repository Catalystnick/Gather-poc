// Phase 2 — chat message state and send

import { useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'

export interface ChatMessage {
  id: string
  name: string
  text: string
  timestamp: number
}

export function useChat(socket: Socket | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [bubbles, setBubbles] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!socket) return

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg])

      setBubbles(prev => new Map(prev).set(msg.id, msg.text))
      setTimeout(() => {
        setBubbles(prev => {
          const next = new Map(prev)
          next.delete(msg.id)
          return next
        })
      }, 5000)
    })

    return () => { socket.off('chat:message') }
  }, [socket])

  function sendMessage(socket: Socket, text: string) {
    socket.emit('chat:message', { text })
  }

  return { messages, bubbles, sendMessage }
}
