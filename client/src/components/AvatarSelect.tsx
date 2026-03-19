import { useState } from 'react'
import type { Avatar, Player } from '../types'

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#ecf0f1',
]

const SHAPES: Avatar['shape'][] = ['capsule', 'box', 'sphere']

interface Props {
  initial: Player | null
  onJoin: (player: Player) => void
}

export default function AvatarSelect({ initial, onJoin }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [shape, setShape] = useState<Avatar['shape']>(initial?.avatar.shape ?? 'capsule')
  const [color, setColor] = useState(initial?.avatar.color ?? '#3498db')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onJoin({ name: name.trim(), avatar: { shape, color } })
  }

  return (
    <div style={styles.overlay}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <h1 style={styles.title}>Gather PoC</h1>

        <label style={styles.label}>Display name</label>
        <input
          style={styles.input}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Enter your name"
          maxLength={24}
          autoFocus
        />

        <label style={styles.label}>Shape</label>
        <div style={styles.row}>
          {SHAPES.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setShape(s)}
              style={{
                ...styles.shapeBtn,
                outline: shape === s ? `2px solid ${color}` : '2px solid transparent',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        <label style={styles.label}>Colour</label>
        <div style={styles.row}>
          {COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              style={{
                ...styles.swatch,
                background: c,
                outline: color === c ? '3px solid #fff' : '3px solid transparent',
              }}
            />
          ))}
        </div>

        <button
          type="submit"
          disabled={!name.trim()}
          style={{
            ...styles.joinBtn,
            opacity: name.trim() ? 1 : 0.4,
            cursor: name.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Join
        </button>
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    width: '100vw', height: '100vh',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#0f0f0f',
  },
  card: {
    background: '#1a1a1a', borderRadius: 12, padding: 32,
    display: 'flex', flexDirection: 'column', gap: 12,
    width: 320, border: '1px solid #2a2a2a',
  },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 8 },
  label: { fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    background: '#0f0f0f', border: '1px solid #333', borderRadius: 6,
    color: '#fff', padding: '8px 12px', fontSize: 15, outline: 'none',
  },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  shapeBtn: {
    background: '#0f0f0f', border: '1px solid #333', borderRadius: 6,
    color: '#fff', padding: '6px 14px', fontSize: 13, cursor: 'pointer',
    textTransform: 'capitalize',
  },
  swatch: {
    width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
  },
  joinBtn: {
    marginTop: 8, background: '#3498db', color: '#fff', border: 'none',
    borderRadius: 6, padding: '10px 0', fontSize: 15, fontWeight: 600,
  },
}
