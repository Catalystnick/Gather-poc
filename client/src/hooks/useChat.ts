import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { ChatMessage } from '../types'

export type { ChatMessage } from '../types'

const MAX_MESSAGES = 200

export function useChat(socket: Socket | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [bubbles, setBubbles] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!socket) return

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages(prev => {
        const next = [...prev, msg]
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
      })

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

  // Closes over socket from state — no need to pass it as a parameter.
  const sendMessage = useCallback((text: string) => {
    socket?.emit('chat:message', { text })
  }, [socket])

  return { messages, bubbles, sendMessage }
}
