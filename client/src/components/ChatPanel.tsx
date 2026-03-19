// Phase 2 — fixed 2D chat overlay in the bottom-left corner

import { useState, useRef, useEffect } from 'react'
import type { ChatMessage } from '../types'

interface Props {
  messages: ChatMessage[]
  onSend: (text: string) => void
}

export default function ChatPanel({ messages, onSend }: Props) {
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [messages])

  function handleSend() {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }

  return (
    <div style={styles.panel}>
      <div ref={logRef} style={styles.log}>
        {messages.map((m) => (
          <div key={`${m.id}-${m.timestamp}`} style={styles.message}>
            <span style={styles.sender}>{m.name}: </span>
            <span>{m.text}</span>
          </div>
        ))}
      </div>
      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Say something..."
        />
        <button style={styles.btn} onClick={handleSend}>Send</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed', bottom: 20, left: 20,
    width: 280, background: 'rgba(0,0,0,0.7)',
    borderRadius: 10, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    border: '1px solid #333',
  },
  log: {
    padding: '8px 10px', maxHeight: 180, overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  message: { fontSize: 13, color: '#fff', lineHeight: 1.4 },
  sender: { fontWeight: 600, color: '#3498db' },
  inputRow: { display: 'flex', borderTop: '1px solid #333' },
  input: {
    flex: 1, background: 'transparent', border: 'none',
    color: '#fff', padding: '8px 10px', fontSize: 13, outline: 'none',
  },
  btn: {
    background: '#3498db', border: 'none', color: '#fff',
    padding: '0 14px', cursor: 'pointer', fontSize: 13,
  },
}
