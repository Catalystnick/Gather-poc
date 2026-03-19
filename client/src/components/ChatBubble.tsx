// Phase 2 — chat bubble rendered in world space above a player's avatar.
// Positioned at world -Z (screen-up in top-down view) relative to the avatar.
// No distanceFactor — orthographic camera has no perspective scaling.

import { Html } from '@react-three/drei'

interface Props {
  text: string
}

export default function ChatBubble({ text }: Props) {
  return (
    <Html position={[0, 0, -1.2]} center>
      <div style={styles.bubble}>{text}</div>
    </Html>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    background: 'rgba(0,0,0,0.75)',
    color: '#fff',
    padding: '3px 8px',
    borderRadius: 10,
    fontSize: 11,
    whiteSpace: 'nowrap',
    maxWidth: 160,
    textAlign: 'center',
    pointerEvents: 'none',
    userSelect: 'none',
  },
}
