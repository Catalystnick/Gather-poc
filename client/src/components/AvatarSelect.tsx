import { useState } from 'react'
import type { Avatar, Player } from '../types'

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#ecf0f1',
]

/** Preview sprite display size (px). */
const SPRITE_DISPLAY = 140
/** Sheet constants — must match AvatarMesh. */
const SHEET_COLS = 8
const SHEET_ROWS = 12

/** Dominant hue of the shirt layer (used for CSS hue-rotate preview). */
const SHIRT_BASE_HUE = 0    // ShirtRed.png is red ~0°

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  let h = 0
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else                h = ((r - g) / d + 4) / 6
  return Math.round(h * 360)
}

const bgSize = `${SPRITE_DISPLAY * SHEET_COLS}px ${SPRITE_DISPLAY * SHEET_ROWS}px`

function spriteLayer(url: string, filter?: string): React.CSSProperties {
  return {
    display: 'block',
    position: 'absolute',
    inset: 0,
    backgroundImage: `url(${url})`,
    backgroundSize: bgSize,
    backgroundPosition: '0 0',
    imageRendering: 'pixelated',
    filter,
  }
}

function CharacterPreview({ shirt }: { shirt: string }) {
  const shirtFilter = `hue-rotate(${hexToHue(shirt) - SHIRT_BASE_HUE}deg) saturate(1.15)`

  return (
    <div style={{ position: 'relative', width: SPRITE_DISPLAY, height: SPRITE_DISPLAY }}>
      {/* Colour glow under feet */}
      <div style={{
        position: 'absolute', bottom: 2, left: '50%',
        transform: 'translateX(-50%)',
        width: 80, height: 18, borderRadius: '50%',
        background: shirt, filter: 'blur(12px)', opacity: 0.7,
      }} />
      {/* Stacked sprite layers */}
      <span style={spriteLayer('/avatars/template.png')} />
      <span style={spriteLayer('/avatars/shoes.png')} />
      <span style={spriteLayer('/avatars/shirt.png', shirtFilter)} />
    </div>
  )
}

interface Props {
  initial: Player | null
  onJoin: (player: Player) => void
}

export default function AvatarSelect({ initial, onJoin }: Props) {
  const [name,  setName]  = useState(initial?.name ?? '')
  const [shirt, setShirt] = useState(initial?.avatar.shirt ?? '#3498db')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onJoin({ name: name.trim(), avatar: { shirt } })
  }

  return (
    <div style={styles.overlay}>
      <form style={styles.card} onSubmit={handleSubmit}>

        <div style={styles.topBar}>
          <span style={styles.topBarTitle}>Gather PoC</span>
        </div>

        <div style={styles.body}>

          {/* ── Left — character + name ── */}
          <div style={styles.leftCol}>
            <div style={styles.stage}>
              <CharacterPreview shirt={shirt} />
            </div>
            <p style={styles.label}>Your Name</p>
            <input
              style={styles.input}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={24}
              autoFocus
            />
          </div>

          {/* ── Right — colours + join ── */}
          <div style={styles.rightCol}>

            <div>
              <p style={styles.label}>Shirt Colour</p>
              <div style={styles.colorGrid}>
                {COLORS.map(c => (
                  <button key={c} type="button" onClick={() => setShirt(c)} style={{
                    ...styles.swatch, background: c,
                    boxShadow: shirt === c ? `0 0 0 2px #1a1a1a, 0 0 0 4px ${c}` : 'none',
                    transform:  shirt === c ? 'scale(1.08)' : 'scale(1)',
                  }} />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!name.trim()}
              style={{
                ...styles.joinBtn,
                opacity: name.trim() ? 1 : 0.35,
                cursor:  name.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Join →
            </button>

          </div>
        </div>
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    width: '100vw', height: '100vh',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#0c0c0c',
  },
  card: {
    background: '#1a1a1a', border: '1px solid #2a2a2a',
    borderRadius: 16, width: 560, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  topBar: {
    padding: '16px 24px', borderBottom: '1px solid #252525', background: '#141414',
  },
  topBarTitle: { fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: -0.3 },
  body: { display: 'flex' },

  leftCol: {
    width: 210, flexShrink: 0,
    borderRight: '1px solid #252525',
    padding: '24px 20px',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  stage: {
    background: '#0f0f0f', border: '1px solid #222', borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 190, marginBottom: 6,
  },

  rightCol: {
    flex: 1, padding: '24px 22px',
    display: 'flex', flexDirection: 'column', gap: 20,
  },

  label: {
    fontSize: 11, fontWeight: 600, color: '#555',
    textTransform: 'uppercase', letterSpacing: 0.8,
    margin: '0 0 8px 0',
  },
  input: {
    background: '#111', border: '1px solid #2e2e2e', borderRadius: 7,
    color: '#fff', padding: '8px 11px', fontSize: 14, outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },

  colorGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
  },
  swatch: {
    aspectRatio: '1', borderRadius: 8, border: 'none', cursor: 'pointer',
    transition: 'transform 0.1s, box-shadow 0.1s',
  },

  joinBtn: {
    marginTop: 'auto', color: '#fff', border: 'none',
    borderRadius: 8, padding: '11px 0',
    fontSize: 15, fontWeight: 700, cursor: 'pointer',
    background: '#3498db',
  },
}
