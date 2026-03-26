// Owns the local microphone pipeline — one getUserMedia call shared across all
// LiveKit rooms (proximity + zone). Both useLiveKitVoice and useZoneVoice receive
// a MicTrack and publish mic.rawMicStreamRef.current to their respective room.
//
// Responsibilities:
//   - getUserMedia / AudioContext / GainNode / Analyser
//   - Local speaking detection (RMS + hysteresis)
//   - Mute / mic-gain state (persisted in localStorage)
//   - Headphone detection and echo-cancel toggle
//   - Audio settings version migration

import { useEffect, useRef, useState } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPEAKING_THRESHOLD    = 35
const SPEAKING_HYSTERESIS_UP   = 2   // frames above threshold → speaking
const SPEAKING_HYSTERESIS_DOWN = 5   // frames below threshold → silent
const MIC_GAIN_STORAGE_KEY  = 'gather_poc_mic_gain'
const AUDIO_SETTINGS_VERSION_KEY = 'gather_poc_audio_settings_version'
const AUDIO_SETTINGS_VERSION     = '2026-03-native-v1'
const DUCK_ATTACK_TC  = 0.02
const DUCK_RELEASE_TC = 0.14
const DUCKING_FACTOR  = 0.25

const AudioContextCtor: typeof AudioContext =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: false,  // Krisp NC handles this; browser NS degrades Krisp accuracy
    autoGainControl:  true,
  } as MediaTrackConstraints,
  video: false,
}

let migrationChecked = false
function ensureMigration() {
  if (migrationChecked) return
  migrationChecked = true
  try {
    if (localStorage.getItem(AUDIO_SETTINGS_VERSION_KEY) === AUDIO_SETTINGS_VERSION) return
    ;['gather_poc_remote_gain', 'gather_poc_mic_gain', 'gather_poc_rolloff',
      'gather_poc_gate_threshold', 'gather_poc_rnnoise'].forEach(k => localStorage.removeItem(k))
    localStorage.setItem(AUDIO_SETTINGS_VERSION_KEY, AUDIO_SETTINGS_VERSION)
  } catch { /* storage unavailable */ }
}

function loadMicGain(): number {
  ensureMigration()
  try {
    const v = Number(localStorage.getItem(MIC_GAIN_STORAGE_KEY))
    return Number.isNaN(v) ? 1 : Math.max(0, v)
  } catch { return 1 }
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface MicTrack {
  // Stable refs — safe to use inside async callbacks across renders.
  rawMicStreamRef: React.MutableRefObject<MediaStream | null>
  audioCtxRef:     React.MutableRefObject<AudioContext | null>
  micGainNodeRef:  React.MutableRefObject<GainNode | null>
  micSourceNodeRef: React.MutableRefObject<MediaStreamAudioSourceNode | null>
  // Mutable state refs (kept in sync with state values below)
  mutedRef:    React.MutableRefObject<boolean>
  micGainRef:  React.MutableRefObject<number>
  duckedRef:   React.MutableRefObject<boolean>
  // React state (triggers re-renders for UI)
  isMuted:         boolean
  toggleMute:      () => void
  isLocalSpeaking: boolean
  micGain:         number
  setMicGain:      (v: number) => void
  headphonePrompt: string | null
  confirmHeadphones: (accept: boolean) => void
  echoCancelEnabled: boolean
  toggleEchoCancel:  () => void
  isReady:         boolean
  // Helpers used by room hooks
  applyEffectiveMicGain: (baseGain: number, duck: boolean) => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMicTrack(): MicTrack {
  const [isMuted,         setIsMuted]         = useState(false)
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false)
  const [micGain,         setMicGainState]    = useState(loadMicGain)
  const [headphonePrompt, setHeadphonePrompt] = useState<string | null>(null)
  const [echoCancelEnabled, setEchoCancelEnabled] = useState(true)
  const [isReady,         setIsReady]         = useState(false)

  const rawMicStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef     = useRef<AudioContext | null>(null)
  const micGainNodeRef  = useRef<GainNode | null>(null)
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)

  const mutedRef   = useRef(false)
  const micGainRef = useRef(loadMicGain())
  const duckedRef  = useRef(false)
  const echoCancelRef = useRef(true)
  const speakingFrames = useRef(0)
  const wasSpeaking    = useRef(false)
  const prevOutputIds  = useRef<Set<string>>(new Set())
  const headphoneIdRef = useRef<string | null>(null)

  // ── Mic setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctx = new AudioContextCtor()
    audioCtxRef.current = ctx
    void ctx.resume().catch(() => {})

    const resumeOnGesture = () => void ctx.resume().catch(() => {})
    window.addEventListener('pointerdown', resumeOnGesture)
    window.addEventListener('keydown',     resumeOnGesture)
    window.addEventListener('touchstart',  resumeOnGesture, { passive: true })

    if ('audioSession' in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'play-and-record'
    }

    if (!navigator.mediaDevices) return

    navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS).then(rawStream => {
      if (ctx.state === 'closed') { rawStream.getTracks().forEach(t => t.stop()); return }
      rawMicStreamRef.current = rawStream

      const gainNode = ctx.createGain()
      gainNode.gain.value = micGainRef.current
      micGainNodeRef.current = gainNode

      const micSource = ctx.createMediaStreamSource(rawStream)
      micSourceNodeRef.current = micSource

      // Route: mic → gain → destination (Krisp will intercept this chain when published)
      const micDest = ctx.createMediaStreamDestination()
      micSource.connect(gainNode).connect(micDest)

      // Analyser taps directly from the raw stream for speaking detection
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      ctx.createMediaStreamSource(rawStream).connect(analyser)
      localAnalyserRef.current = analyser

      void ctx.resume().catch(() => {})
      setIsReady(true)
    }).catch(err => console.error('[mic] getUserMedia denied:', err))

    return () => {
      window.removeEventListener('pointerdown', resumeOnGesture)
      window.removeEventListener('keydown',     resumeOnGesture)
      window.removeEventListener('touchstart',  resumeOnGesture)
      rawMicStreamRef.current?.getTracks().forEach(t => t.stop())
      micSourceNodeRef.current = null
      void ctx.close()
    }
  }, [])

  // ── Speaking detection interval ────────────────────────────────────────────
  useEffect(() => {
    const buf = new Uint8Array(128)
    const id = setInterval(() => {
      const analyser = localAnalyserRef.current
      if (!analyser) return
      analyser.getByteFrequencyData(buf)
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
      const above = rms > SPEAKING_THRESHOLD
      speakingFrames.current = above
        ? Math.min(SPEAKING_HYSTERESIS_UP,    speakingFrames.current + 1)
        : Math.max(-SPEAKING_HYSTERESIS_DOWN, speakingFrames.current - 1)
      const speaking = !mutedRef.current && (
        speakingFrames.current >= SPEAKING_HYSTERESIS_UP ||
        (wasSpeaking.current && speakingFrames.current > -SPEAKING_HYSTERESIS_DOWN)
      )
      wasSpeaking.current = speaking
      setIsLocalSpeaking(speaking)
    }, 100)
    return () => clearInterval(id)
  }, [])

  // ── Headphone detection ────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return
    let disposed = false

    navigator.mediaDevices.enumerateDevices().then(devs => {
      if (disposed) return
      prevOutputIds.current = new Set(devs.filter(d => d.kind === 'audiooutput').map(d => d.deviceId))
    }).catch(() => {})

    async function onDeviceChange() {
      if (disposed) return
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const outputs = devs.filter(d => d.kind === 'audiooutput')
        const newIds = new Set(outputs.map(d => d.deviceId))
        const appeared = outputs.filter(d => !prevOutputIds.current.has(d.deviceId) && d.deviceId !== 'default' && d.deviceId !== 'communications')
        const disappeared = [...prevOutputIds.current].filter(id => !newIds.has(id))
        prevOutputIds.current = newIds

        if (headphoneIdRef.current && disappeared.includes(headphoneIdRef.current)) {
          headphoneIdRef.current = null
          if (!echoCancelRef.current) {
            setEchoCancelEnabled(true)
            echoCancelRef.current = true
            const track = rawMicStreamRef.current?.getAudioTracks()[0]
            if (track) await track.applyConstraints({ echoCancellation: true }).catch(() => {})
          }
        }
        if (appeared.length > 0) {
          headphoneIdRef.current = appeared[0].deviceId
          setHeadphonePrompt(appeared[0].label || 'New audio device')
        }
      } catch { /* ignore */ }
    }

    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => { disposed = true; navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange) }
  }, [])

  // ── Controls ───────────────────────────────────────────────────────────────

  function applyEffectiveMicGain(baseGain: number, duck: boolean) {
    const ctx  = audioCtxRef.current
    const node = micGainNodeRef.current
    if (!ctx || !node) return
    const effective = mutedRef.current ? 0 : baseGain
    const target    = duck ? effective * DUCKING_FACTOR : effective
    node.gain.setTargetAtTime(target, ctx.currentTime, duck ? DUCK_ATTACK_TC : DUCK_RELEASE_TC)
    duckedRef.current = duck && effective > 0
  }

  function toggleMute() {
    setIsMuted(prev => {
      const next = !prev
      mutedRef.current = next
      rawMicStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next })
      if (next) { wasSpeaking.current = false; speakingFrames.current = 0; setIsLocalSpeaking(false) }
      applyEffectiveMicGain(micGainRef.current, duckedRef.current)
      return next
    })
  }

  function setMicGain(value: number) {
    const next = Math.max(0, value)
    setMicGainState(next)
    micGainRef.current = next
    applyEffectiveMicGain(next, duckedRef.current)
    try { localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  function confirmHeadphones(accept: boolean) {
    setHeadphonePrompt(null)
    if (!accept) headphoneIdRef.current = null
  }

  async function toggleEchoCancel() {
    const next = !echoCancelRef.current
    setEchoCancelEnabled(next)
    echoCancelRef.current = next
    const track = rawMicStreamRef.current?.getAudioTracks()[0]
    if (track) await track.applyConstraints({ echoCancellation: next }).catch(() => {})
  }

  return {
    rawMicStreamRef, audioCtxRef, micGainNodeRef, micSourceNodeRef,
    mutedRef, micGainRef, duckedRef,
    isMuted, toggleMute,
    isLocalSpeaking,
    micGain, setMicGain,
    headphonePrompt, confirmHeadphones,
    echoCancelEnabled, toggleEchoCancel,
    isReady,
    applyEffectiveMicGain,
  }
}
