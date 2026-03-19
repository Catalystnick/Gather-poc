// Phase 2 — mute/unmute toggle for proximity voice

import { useState, useEffect } from 'react'

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

interface Props {
  muted: boolean
  onToggle: () => void
  remoteGain: number
  onGainChange: (value: number) => void
  micGain: number
  onMicGainChange: (value: number) => void
  rolloff: number
  onRolloffChange: (value: number) => void
  hpfFreq: number
  onHpfFreqChange: (value: number) => void
  agcEnabled: boolean
  onAgcToggle: () => void
  gateThreshold: number
  onGateThresholdChange: (v: number) => void
  audioBlocked?: boolean
  audioInterrupted?: boolean
}

export default function VoiceControls({ muted, onToggle, remoteGain, onGainChange, micGain, onMicGainChange, rolloff, onRolloffChange, hpfFreq, onHpfFreqChange, agcEnabled, onAgcToggle, gateThreshold, onGateThresholdChange, audioBlocked, audioInterrupted }: Props) {
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
        {IS_MOBILE && (
          <div style={styles.mobileBadge} title={`Detected platform: ${PLATFORM_LABEL}`}>
            📱 {PLATFORM_LABEL}
          </div>
        )}
        <button style={styles.btn} onClick={onToggle} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? '🔇 Muted' : '🎤 Live'}
        </button>
        <GainControl label="🔊 Speaker" value={remoteGain} onChange={onGainChange} />
        <GainControl label="🎙 Mic"     value={micGain}    onChange={onMicGainChange} />
        <GainControl
          label="🎚 Bass cut"
          value={hpfFreq}
          onChange={onHpfFreqChange}
          min={20}
          sliderMax={1000}
          step={10}
          unit="Hz"
          title="Highpass filter cutoff. 20Hz = off, 80Hz = remove rumble, 200–400Hz = cut bassy voice, 800Hz+ = very thin"
        />
        <GainControl
          label="📉 Rolloff"
          value={rolloff}
          onChange={onRolloffChange}
          min={0.1}
          sliderMax={4}
          step={0.1}
          title="Distance attenuation curve. 0.5 = gradual, 1.0 = linear, 1.4 = default, 2.0 = inverse-square, 3+ = sharp cutoff"
        />
        <GainControl
          label="🔇 Noise gate"
          value={gateThreshold}
          onChange={onGateThresholdChange}
          min={0}
          sliderMax={80}
          step={1}
          unit="rms"
          title="Noise gate: mic is silenced when its RMS level is below this threshold. 0 = off. ~10 = light (blocks dead silence), ~25 = medium (blocks background hum), ~50 = aggressive."
        />
        <button
          style={{ ...styles.btn, ...styles.agcBtn, background: agcEnabled ? 'rgba(34,197,94,0.25)' : 'rgba(0,0,0,0.7)' }}
          onClick={onAgcToggle}
          title="Automatic Gain Control normalises your mic volume. Disable if you prefer manual control via the Mic slider."
        >
          AGC {agcEnabled ? 'ON' : 'OFF'}
        </button>
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
  agcBtn: {
    fontSize: 12,
    padding: '4px 14px',
    border: '1px solid #555',
    borderRadius: 20,
    cursor: 'pointer',
    color: '#fff',
    transition: 'background 0.15s',
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
}
