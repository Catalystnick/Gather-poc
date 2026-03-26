import { useState, useEffect } from 'react'
import { useVoice } from '../../contexts/VoiceContext'

// Slider soft-max: dragging covers 0–SLIDER_MAX.
// Values above this are still reachable via the text input.
const SLIDER_MAX = 10;

interface GainControlProps {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  sliderMax?: number
  step?: number
  unit?: string
  precision?: number
  title?: string
}

function GainControl({
  label,
  value,
  onChange,
  min = 0,
  sliderMax = SLIDER_MAX,
  step = 0.1,
  unit = 'x',
  precision = 1,
  title,
}: GainControlProps) {
  const [text, setText] = useState(value.toFixed(precision))
  const [focused, setFocused] = useState(false)

  // When the slider (or any external source) changes the value, update the
  // text field — but only while the text field isn't actively being edited.
  useEffect(() => {
    if (!focused) setText(value.toFixed(precision))
  }, [value, focused, precision])

  function commitText(raw: string) {
    const v = parseFloat(raw)
    if (!Number.isNaN(v) && v >= min) {
      onChange(v)
    } else {
      setText(value.toFixed(precision))
    }
  }

  return (
    <div style={styles.gainRow} title={title}>
      <span style={styles.gainLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={sliderMax}
        step={step}
        value={Math.min(sliderMax, Math.max(min, value))}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={styles.slider}
      />
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v) && v >= min) onChange(v)
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { setFocused(false); commitText(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        style={styles.gainInput}
      />
      <span style={styles.gainUnit}>{unit}</span>
    </div>
  )
}

const ZONE_LABELS: Record<string, string> = {
  dev: 'Dev Zone',
  design: 'Design Zone',
  game: 'Game Zone',
}

function ModeLabel({ mode, activeZoneKey }: { mode: string; activeZoneKey: string | null }) {
  if (mode === 'switching') return <span style={styles.modeBadgeSwitching}>Switching...</span>
  if (mode === 'zone' && activeZoneKey) {
    return <span style={styles.modeBadgeZone}>{ZONE_LABELS[activeZoneKey] ?? activeZoneKey}</span>
  }
  return <span style={styles.modeBadgeProximity}>Proximity</span>
}

export default function VoiceControls() {
  const {
    muted,
    toggleMute,
    remoteGain,
    setRemoteGain,
    krispEnabled,
    toggleKrispEnabled,
    headphonePrompt,
    confirmHeadphones,
    audioBlocked,
    audioInterrupted,
    mode,
    activeZoneKey,
  } = useVoice()

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
      {headphonePrompt && (
        <div style={styles.headphoneBanner}>
          <span>🎧 <strong>{headphonePrompt}</strong> detected — disable echo cancellation for better quality?</span>
          <div style={styles.headphoneBannerBtns}>
            <button style={styles.headphoneBtn} onClick={() => confirmHeadphones(true)}>
              Yes, disable AEC
            </button>
            <button style={{ ...styles.headphoneBtn, ...styles.headphoneBtnDismiss }} onClick={() => confirmHeadphones(false)}>
              No, keep it
            </button>
          </div>
        </div>
      )}
      <div style={styles.wrapper}>
        <div style={styles.muteRow}>
          <button style={styles.btn} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇 Muted' : '🎤 Live'}
          </button>
          <button
            style={{ ...styles.btn, borderColor: krispEnabled ? '#16a34a' : '#6b7280' }}
            onClick={toggleKrispEnabled}
            title="Toggle Krisp noise cancellation"
          >
            {krispEnabled ? 'Krisp: ON' : 'Krisp: OFF'}
          </button>
          <ModeLabel mode={mode} activeZoneKey={activeZoneKey} />
        </div>
        <GainControl
          label="🔊 Speaker"
          value={remoteGain}
          onChange={setRemoteGain}
          sliderMax={1}
          step={0.01}
          precision={2}
          unit=""
          title="Playback volume (0–1)"
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
  muteRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  btn: {
    background: 'rgba(0,0,0,0.7)', color: '#fff',
    border: '1px solid #444', borderRadius: 20,
    padding: '8px 20px', fontSize: 14, cursor: 'pointer',
  },
  modeBadgeProximity: {
    fontSize: 11, fontWeight: 600,
    color: '#94a3b8',
    background: 'rgba(0,0,0,0.5)',
    border: '1px solid rgba(148,163,184,0.3)',
    padding: '3px 10px', borderRadius: 20,
    pointerEvents: 'none' as const,
  },
  modeBadgeZone: {
    fontSize: 11, fontWeight: 700,
    color: '#6ee7b7',
    background: 'rgba(16,185,129,0.15)',
    border: '1px solid rgba(110,231,183,0.4)',
    padding: '3px 10px', borderRadius: 20,
    pointerEvents: 'none' as const,
  },
  modeBadgeSwitching: {
    fontSize: 11, fontWeight: 600,
    color: '#fbbf24',
    background: 'rgba(245,158,11,0.15)',
    border: '1px solid rgba(251,191,36,0.4)',
    padding: '3px 10px', borderRadius: 20,
    pointerEvents: 'none' as const,
  },
  gainRow: {
    display: 'flex',
    flexDirection: 'row' as const,
    alignItems: 'center',
    gap: 6,
  },
  gainLabel: {
    fontSize: 12,
    color: '#ddd',
    minWidth: 80,
    textAlign: 'right' as const,
  },
  slider: {
    width: 120,
    accentColor: '#3498db',
    cursor: 'pointer',
  },
  gainInput: {
    width: 52,
    background: 'rgba(0,0,0,0.7)',
    color: '#fff',
    border: '1px solid #555',
    borderRadius: 6,
    padding: '3px 6px',
    fontSize: 13,
    textAlign: 'center' as const,
    outline: 'none',
  },
  gainUnit: {
    fontSize: 12,
    color: '#aaa',
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
  headphoneBanner: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(14, 116, 144, 0.95)',
    color: '#fff',
    padding: '12px 20px',
    borderRadius: 12,
    fontSize: 14,
    zIndex: 9999,
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 10,
    maxWidth: 420,
    textAlign: 'center' as const,
  },
  headphoneBannerBtns: {
    display: 'flex',
    gap: 8,
  },
  headphoneBtn: {
    background: 'rgba(255,255,255,0.2)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.4)',
    borderRadius: 8,
    padding: '5px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  headphoneBtnDismiss: {
    background: 'transparent',
    fontWeight: 400,
  },
}
