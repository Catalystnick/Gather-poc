// Phase 2 — mute/unmute toggle for proximity voice

interface Props {
  muted: boolean
  onToggle: () => void
  remoteGain: number
  onGainChange: (value: number) => void
  audioBlocked?: boolean
  audioInterrupted?: boolean
}

export default function VoiceControls({ muted, onToggle, remoteGain, onGainChange, audioBlocked, audioInterrupted }: Props) {
  return (
    <>
      {audioInterrupted && (
        <div style={styles.blockedBanner}>
          Voice paused — end phone call to restore
        </div>
      )}
      {audioBlocked && !audioInterrupted && (
        <div style={styles.blockedBanner}>
          Tap anywhere to enable voice audio
        </div>
      )}
      <div style={styles.wrapper}>
        <button style={styles.btn} onClick={onToggle} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? '🔇 Muted' : '🎤 Live'}
        </button>
        <label style={styles.gainLabel}>
          Voice gain: {remoteGain.toFixed(1)}x
        </label>
        <input
          type="range"
          min={0.5}
          max={5}
          step={0.1}
          value={remoteGain}
          onChange={(e) => onGainChange(Number(e.target.value))}
          style={styles.slider}
        />
      </div>
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'fixed', bottom: 20, left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  btn: {
    background: 'rgba(0,0,0,0.7)', color: '#fff',
    border: '1px solid #444', borderRadius: 20,
    padding: '8px 20px', fontSize: 14, cursor: 'pointer',
  },
  gainLabel: {
    fontSize: 12,
    color: '#ddd',
    background: 'rgba(0,0,0,0.65)',
    padding: '2px 8px',
    borderRadius: 8,
  },
  slider: {
    width: 180,
    accentColor: '#3498db',
  },
  blockedBanner: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(220, 38, 38, 0.92)',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 600,
    pointerEvents: 'none',
    zIndex: 9999,
    whiteSpace: 'nowrap',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
  },
}
