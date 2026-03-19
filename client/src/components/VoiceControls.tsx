// Phase 2 — mute/unmute toggle for proximity voice

interface Props {
  muted: boolean
  onToggle: () => void
}

export default function VoiceControls({ muted, onToggle }: Props) {
  return (
    <div style={styles.wrapper}>
      <button style={styles.btn} onClick={onToggle} title={muted ? 'Unmute' : 'Mute'}>
        {muted ? '🎤 Muted' : '🎤 Live'}
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'fixed', bottom: 20, left: '50%',
    transform: 'translateX(-50%)',
  },
  btn: {
    background: 'rgba(0,0,0,0.7)', color: '#fff',
    border: '1px solid #444', borderRadius: 20,
    padding: '8px 20px', fontSize: 14, cursor: 'pointer',
  },
}
