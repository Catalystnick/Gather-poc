import { useState, useEffect } from 'react'
import { useVoice } from '../../contexts/VoiceContext'

const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const IS_IOS    = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const PLATFORM_LABEL = IS_IOS ? 'iOS' : /Android/i.test(navigator.userAgent) ? 'Android' : 'Mobile';

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
  title?: string
}

function GainControl({ label, value, onChange, min = 0, sliderMax = SLIDER_MAX, step = 0.1, unit = 'x', title }: GainControlProps) {
  const [text, setText] = useState(value.toFixed(1))
  const [focused, setFocused] = useState(false)

  // When the slider (or any external source) changes the value, update the
  // text field — but only while the text field isn't actively being edited.
  useEffect(() => {
    if (!focused) setText(value.toFixed(1))
  }, [value, focused])

  function commitText(raw: string) {
    const v = parseFloat(raw)
    if (!Number.isNaN(v) && v >= min) {
      onChange(v)
    } else {
      setText(value.toFixed(1))
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

export default function VoiceControls() {
  const {
    muted,
    toggleMute,
    remoteGain,
    setRemoteGain,
    micGain,
    setMicGain,
    headphonePrompt,
    confirmHeadphones,
    audioBlocked,
    audioInterrupted,
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
        {IS_MOBILE && (
          <div style={styles.mobileBadge} title={`Detected platform: ${PLATFORM_LABEL}`}>
            📱 {PLATFORM_LABEL}
          </div>
        )}
        <button style={styles.btn} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? '🔇 Muted' : '🎤 Live'}
        </button>
        <GainControl label="🔊 Speaker" value={remoteGain} onChange={setRemoteGain} />
        <GainControl label="🎙 Mic"     value={micGain}    onChange={setMicGain} />
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
  mobileBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: '#a5f3fc',
    background: 'rgba(0,0,0,0.55)',
    border: '1px solid rgba(165,243,252,0.3)',
    padding: '3px 10px',
    borderRadius: 20,
    letterSpacing: '0.03em',
    pointerEvents: 'none' as const,
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
