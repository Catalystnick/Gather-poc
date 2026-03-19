// Phase 2 — renders a chat bubble above a player's avatar in world space
// Displayed using Drei <Html> so it always faces the camera

import { Html } from '@react-three/drei'

interface Props {
  text: string
}

export default function ChatBubble({ text }: Props) {
  return (
    <Html position={[0, 2, 0]} center distanceFactor={8}>
      <div style={styles.bubble}>{text}</div>
    </Html>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    background: 'rgba(0,0,0,0.75)',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: 12,
    fontSize: 13,
    whiteSpace: 'nowrap',
    maxWidth: 200,
    textAlign: 'center',
    pointerEvents: 'none',
  },
}
