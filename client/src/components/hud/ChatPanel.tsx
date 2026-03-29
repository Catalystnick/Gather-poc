import { useState, useRef, useEffect } from 'react'
import HUDPanel from './HUDPanel'
import type { ChatMessage } from '../../types'

interface Props {
  messages: ChatMessage[]
  onSend: (text: string) => void
}

/** Chat HUD panel with scrolling message log and quick send input. */
export default function ChatPanel({ messages, onSend }: Props) {
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [messages])

  /** Send current input as a chat message and clear the entry box. */
  function handleSend() {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }

  return (
    <HUDPanel style={styles.position}>
      <div ref={logRef} style={styles.log}>
        {messages.map((message) => (
          <div key={`${message.id}-${message.timestamp}`} style={styles.message}>
            <span style={styles.sender}>{message.name}: </span>
            <span>{message.text}</span>
          </div>
        ))}
      </div>
      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && handleSend()}
          placeholder="Say something..."
        />
        <button style={styles.btn} onClick={handleSend}>Send</button>
      </div>
    </HUDPanel>
  )
}

const styles: Record<string, React.CSSProperties> = {
  position: {
    bottom: 20,
    left: 20,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
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
