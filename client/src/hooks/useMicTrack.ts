// Owns the local microphone pipeline — one getUserMedia call shared across all
// LiveKit rooms (proximity + zone). Both rooms receive a MicTrack and publish
// raw hardware track clones to their respective room. Krisp noise cancellation
// is applied per-room via LocalTrackPublished.
//
// Responsibilities:
//   - getUserMedia / AudioContext / AnalyserNode
//   - Local speaking detection (RMS + hysteresis)
//   - Mute state (propagated to all registered published clones)
//   - Headphone detection and echo-cancel toggle
//   - Audio settings version migration

import { useEffect, useRef, useState } from 'react'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPEAKING_THRESHOLD       = 20
const SPEAKING_HYSTERESIS_UP   = 2   // frames above threshold → speaking
const SPEAKING_HYSTERESIS_DOWN = 5   // frames below threshold → silent
const AUDIO_SETTINGS_VERSION_KEY = 'gather_poc_audio_settings_version'
const AUDIO_SETTINGS_VERSION     = '2026-03-native-v1'

const AudioContextCtor: typeof AudioContext =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: !isKrispNoiseFilterSupported(), // native NS only when Krisp unavailable
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

// ─── Public interface ─────────────────────────────────────────────────────────

export interface MicTrack {
  // Stable refs — safe to use inside async callbacks across renders.
  rawMicStreamRef: React.MutableRefObject<MediaStream | null>
  audioCtxRef:     React.MutableRefObject<AudioContext | null>
  mutedRef:        React.MutableRefObject<boolean>
  // React state (triggers re-renders for UI)
  isMuted:          boolean
  toggleMute:       () => void
  isLocalSpeaking:  boolean
  headphonePrompt:  string | null
  confirmHeadphones: (accept: boolean) => void
  echoCancelEnabled: boolean
  toggleEchoCancel:  () => void
  isReady:          boolean
  // Published clone registry — mute/unmute propagates to all registered clones.
  // Each room hook registers its clone when publishing and unregisters on disconnect.
  addPublishedClone:    (track: MediaStreamTrack) => void
  removePublishedClone: (track: MediaStreamTrack) => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMicTrack(): MicTrack {
  const [isMuted,           setIsMuted]           = useState(false)
  const [isLocalSpeaking,   setIsLocalSpeaking]   = useState(false)
  const [headphonePrompt,   setHeadphonePrompt]   = useState<string | null>(null)
  const [echoCancelEnabled, setEchoCancelEnabled] = useState(true)
  const [isReady,           setIsReady]           = useState(false)

  const rawMicStreamRef  = useRef<MediaStream | null>(null)
  const audioCtxRef      = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)

  const mutedRef          = useRef(false)
  const echoCancelRef     = useRef(true)
  const speakingFrames    = useRef(0)
  const wasSpeaking       = useRef(false)
  const prevOutputIds     = useRef<Set<string>>(new Set())
  const headphoneIdRef    = useRef<string | null>(null)
  const publishedClonesRef = useRef<Set<MediaStreamTrack>>(new Set())

  // ── Mic setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ensureMigration()
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

      // Analyser taps directly from the raw stream for local speaking detection
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

  function addPublishedClone(track: MediaStreamTrack) {
    publishedClonesRef.current.add(track)
    // Immediately apply current mute state so late-registered clones are consistent
    track.enabled = !mutedRef.current
  }

  function removePublishedClone(track: MediaStreamTrack) {
    publishedClonesRef.current.delete(track)
  }

  function toggleMute() {
    setIsMuted(prev => {
      const next = !prev
      mutedRef.current = next
      rawMicStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next })
      publishedClonesRef.current.forEach(t => { t.enabled = !next })
      if (next) { wasSpeaking.current = false; speakingFrames.current = 0; setIsLocalSpeaking(false) }
      return next
    })
  }

  async function confirmHeadphones(accept: boolean) {
    setHeadphonePrompt(null)
    if (!accept) {
      headphoneIdRef.current = null
      return
    }
    // User confirmed headphones → disable AEC for better quality.
    setEchoCancelEnabled(false)
    echoCancelRef.current = false
    const track = rawMicStreamRef.current?.getAudioTracks()[0]
    await track?.applyConstraints({ echoCancellation: false }).catch(() => {})
  }

  async function toggleEchoCancel() {
    const next = !echoCancelRef.current
    setEchoCancelEnabled(next)
    echoCancelRef.current = next
    const track = rawMicStreamRef.current?.getAudioTracks()[0]
    if (track) await track.applyConstraints({ echoCancellation: next }).catch(() => {})
  }

  return {
    rawMicStreamRef, audioCtxRef, mutedRef,
    isMuted, toggleMute,
    isLocalSpeaking,
    headphonePrompt, confirmHeadphones,
    echoCancelEnabled, toggleEchoCancel,
    isReady,
    addPublishedClone, removePublishedClone,
  }
}
