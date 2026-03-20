import { useState } from 'react'
import type { Avatar, Player } from '../types'

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#ecf0f1',
]

const SHAPES: Avatar['shape'][] = ['swordsman', 'box', 'sphere']

const SPRITE_DISPLAY = 140

/** Approximate dominant hue of the swordsman sprite art (warm brown/skin tones ~25°). */
const SPRITE_BASE_HUE = 25

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

interface Props {
  initial: Player | null
  onJoin: (player: Player) => void
}

function CharacterPreview({ shape, color }: { shape: Avatar['shape']; color: string }) {
  if (shape === 'swordsman') {
    const hueRotate = hexToHue(color) - SPRITE_BASE_HUE
    return (
      <div style={{ position: 'relative', width: SPRITE_DISPLAY, height: SPRITE_DISPLAY }}>
        {/* Coloured glow shadow under feet */}
        <div style={{
          position: 'absolute', bottom: 2, left: '50%',
          transform: 'translateX(-50%)',
          width: 90, height: 22,
          borderRadius: '50%',
          background: color,
          filter: 'blur(14px)',
          opacity: 0.8,
        }} />
        {/* Sprite — filter applies only to this element's pixels, not the background */}
        <span style={{
          display: 'block',
          width: SPRITE_DISPLAY, height: SPRITE_DISPLAY,
          backgroundImage: 'url(/avatars/swordsman-idle.png)',
          backgroundSize: `${SPRITE_DISPLAY * 12}px ${SPRITE_DISPLAY * 4}px`,
          backgroundPosition: '0 0',
          imageRendering: 'pixelated',
          position: 'relative', zIndex: 1,
          filter: `hue-rotate(${hueRotate}deg) saturate(1.15)`,
        }} />
      </div>
    )
  }

  return (
    <div style={{
      width: 100, height: 100,
      background: color,
      borderRadius: shape === 'sphere' ? '50%' : 14,
      boxShadow: `0 8px 36px ${color}99`,
    }} />
  )
}

export default function AvatarSelect({ initial, onJoin }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [shape, setShape] = useState<Avatar['shape']>(initial?.avatar.shape ?? 'swordsman')
  const [color, setColor] = useState(initial?.avatar.color ?? '#3498db')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onJoin({ name: name.trim(), avatar: { shape, color } })
  }

  return (
    <div style={styles.overlay}>
      <form style={styles.card} onSubmit={handleSubmit}>

        {/* ── Top bar ── */}
        <div style={styles.topBar}>
          <span style={styles.topBarTitle}>Gather PoC</span>
        </div>

        {/* ── Two-column body ── */}
        <div style={styles.body}>

          {/* Left — character stage + name */}
          <div style={styles.leftCol}>
            <div style={styles.stage}>
              <CharacterPreview shape={shape} color={color} />
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

          {/* Right — avatar + colour + join */}
          <div style={styles.rightCol}>

            <div>
              <p style={styles.label}>Choose Avatar</p>
              <div style={styles.shapeList}>
                {SHAPES.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setShape(s)}
                    style={{
                      ...styles.shapeBtn,
                      borderColor: shape === s ? color : '#2e2e2e',
                      background: shape === s ? '#252525' : '#111',
                      color: shape === s ? '#fff' : '#777',
                    }}
                  >
                    {s === 'swordsman' ? (
                      <>
                        <span style={styles.swordsmanThumb} />
                        Swordsman
                      </>
                    ) : s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p style={styles.label}>Choose Colour</p>
              <div style={styles.colorGrid}>
                {COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{
                      ...styles.swatch,
                      background: c,
                      boxShadow: color === c
                        ? `0 0 0 2px #1a1a1a, 0 0 0 4px ${c}`
                        : 'none',
                      transform: color === c ? 'scale(1.08)' : 'scale(1)',
                    }}
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!name.trim()}
              style={{
                ...styles.joinBtn,
                background: color,
                opacity: name.trim() ? 1 : 0.35,
                cursor: name.trim() ? 'pointer' : 'not-allowed',
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
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 16,
    width: 560,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },

  topBar: {
    padding: '16px 24px',
    borderBottom: '1px solid #252525',
    background: '#141414',
  },
  topBarTitle: { fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: -0.3 },

  body: {
    display: 'flex',
  },

  // ── Left column ──
  leftCol: {
    width: 210,
    flexShrink: 0,
    borderRight: '1px solid #252525',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  stage: {
    background: '#0f0f0f',
    border: '1px solid #222',
    borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 190,
    marginBottom: 6,
  },

  // ── Right column ──
  rightCol: {
    flex: 1,
    padding: '24px 22px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
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

  shapeList: { display: 'flex', flexDirection: 'column', gap: 6 },
  shapeBtn: {
    display: 'flex', alignItems: 'center', gap: 9,
    border: '1px solid',
    borderRadius: 7, padding: '7px 11px',
    fontSize: 13, cursor: 'pointer',
    textTransform: 'capitalize',
    textAlign: 'left', width: '100%',
    transition: 'border-color 0.1s, background 0.1s, color 0.1s',
  },
  swordsmanThumb: {
    display: 'inline-block', flexShrink: 0,
    width: 22, height: 22,
    backgroundImage: 'url(/avatars/swordsman-idle.png)',
    backgroundSize: `${22 * 12}px ${22 * 4}px`,
    backgroundPosition: '0 0',
    imageRendering: 'pixelated',
    borderRadius: 2,
  },

  colorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
  },
  swatch: {
    aspectRatio: '1',
    borderRadius: 8, border: 'none', cursor: 'pointer',
    transition: 'transform 0.1s, box-shadow 0.1s',
  },

  joinBtn: {
    marginTop: 'auto',
    color: '#fff', border: 'none',
    borderRadius: 8, padding: '11px 0',
    fontSize: 15, fontWeight: 700, cursor: 'pointer',
    letterSpacing: 0.2,
    transition: 'opacity 0.15s',
  },
}
