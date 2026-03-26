// Owns the local microphone pipeline — mic is acquired with LiveKit
// `createLocalAudioTrack` (constraints + device handling align with the SDK).
// Proximity vs zone switches which LiveKit room carries voice, but the same
// hardware stream backs whichever path publishes. Krisp runs on the real
// capture LocalAudioTrack from createLocalAudioTrack (setProcessor uses
// applyConstraints — Web Audio destination tracks throw OverconstrainedError).
// The denoised track feeds the VAD gate → user gain → publish stream.
//
// Responsibilities:
//   - createLocalAudioTrack / shared AudioContext
//   - Silero VAD (@ricky0123/vad-web) on same mic stream; analyser RMS fallback
//   - VAD gate on send path (Web Audio gain 0 when not locally “speaking”)
//   - Mute state (propagated to all registered published clones)
//   - Headphone detection and echo-cancel toggle
//   - Audio settings version migration

import { useEffect, useRef, useState } from 'react'
import { MicVAD } from '@ricky0123/vad-web'
import { createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import { applyKrispNoiseFilterFromDocs } from '../utils/voiceRoom'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPEAKING_THRESHOLD       = 20
const SPEAKING_HYSTERESIS_UP   = 2   // frames above threshold → speaking
const SPEAKING_HYSTERESIS_DOWN = 5   // frames below threshold → silent
const MIC_GAIN_STORAGE_KEY = 'gather_poc_mic_gain'
const AUDIO_SETTINGS_VERSION_KEY = 'gather_poc_audio_settings_version'
const AUDIO_SETTINGS_VERSION     = '2026-03-native-v1'

const AudioContextCtor: typeof AudioContext =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

/** Options for `createLocalAudioTrack` — Krisp wants minimal browser NC when supported. */
function getMicCaptureOptions() {
  const krisp = isKrispNoiseFilterSupported()
  return {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: !krisp,
    ...(krisp ? { voiceIsolation: false } : {}),
  }
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
  try {
    const v = Number(localStorage.getItem(MIC_GAIN_STORAGE_KEY))
    return Number.isNaN(v) ? 1 : Math.max(0, v)
  } catch { return 1 }
}

/** Trailing-slash base for VAD worklet + ONNX + ORT WASM (vite static copy → site root). */
function vadAssetBase(): string {
  const b = import.meta.env.BASE_URL || '/'
  return b.endsWith('/') ? b : `${b}/`
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface MicTrack {
  // Stable refs — safe to use inside async callbacks across renders.
  /** LiveKit capture stream (hardware) — AEC/constraints, not for send; input to Web Audio graph. */
  rawMicStreamRef: React.MutableRefObject<MediaStream | null>
  /** VAD-gated + user-gain processed stream — publish this track to LiveKit. */
  sendMicStreamRef: React.MutableRefObject<MediaStream | null>
  audioCtxRef:     React.MutableRefObject<AudioContext | null>
  micGainNodeRef:  React.MutableRefObject<GainNode | null>
  micSourceNodeRef: React.MutableRefObject<MediaStreamAudioSourceNode | null>
  mutedRef:        React.MutableRefObject<boolean>
  // React state (triggers re-renders for UI)
  isMuted:          boolean
  toggleMute:       () => void
  micGain:          number
  setMicGain:       (v: number) => void
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
  /** Same value as micGain; stable ref for processors / async publish paths. */
  micGainRef: React.MutableRefObject<number>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMicTrack(): MicTrack {
  const [isMuted,           setIsMuted]           = useState(false)
  const [micGain,           setMicGainState]      = useState(loadMicGain)
  const [isLocalSpeaking,   setIsLocalSpeaking]   = useState(false)
  const [headphonePrompt,   setHeadphonePrompt]   = useState<string | null>(null)
  const [echoCancelEnabled, setEchoCancelEnabled] = useState(true)
  const [isReady,           setIsReady]           = useState(false)
  /** null = VAD not resolved yet; silero = @ricky0123/vad-web; analyser = RMS fallback */
  const [vadBackend,       setVadBackend]        = useState<'silero' | 'analyser' | null>(null)

  const rawMicStreamRef  = useRef<MediaStream | null>(null)
  const sendMicStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef      = useRef<AudioContext | null>(null)
  const micGainNodeRef = useRef<GainNode | null>(null)
  const vadGateGainRef   = useRef<GainNode | null>(null)
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)

  const mutedRef          = useRef(false)
  const micGainRef        = useRef(loadMicGain())
  const echoCancelRef     = useRef(true)
  const speakingFrames    = useRef(0)
  const wasSpeaking       = useRef(false)
  const prevOutputIds     = useRef<Set<string>>(new Set())
  const headphoneIdRef    = useRef<string | null>(null)
  const publishedClonesRef = useRef<Set<MediaStreamTrack>>(new Set())
  /** LiveKit handle for the captured mic — stopped on unmount. */
  const sourceLocalAudioRef = useRef<LocalAudioTrack | null>(null)
  const micVadRef            = useRef<MicVAD | null>(null)

  // ── Mic setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ensureMigration()
    let disposed = false
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

    if (!navigator.mediaDevices) {
      void ctx.close()
      audioCtxRef.current = null
      window.removeEventListener('pointerdown', resumeOnGesture)
      window.removeEventListener('keydown',     resumeOnGesture)
      window.removeEventListener('touchstart',  resumeOnGesture)
      return () => {}
    }

    void createLocalAudioTrack(getMicCaptureOptions())
      .then(async localTrack => {
        if (ctx.state === 'closed' || disposed) {
          void localTrack.stop()
          return
        }
        sourceLocalAudioRef.current = localTrack
        const rawTrack = localTrack.mediaStreamTrack
        const rawStream = localTrack.mediaStream ?? new MediaStream([rawTrack])
        rawMicStreamRef.current = rawStream

        let sendInputStream: MediaStream = rawStream
        if (isKrispNoiseFilterSupported()) {
          localTrack.setAudioContext(ctx)
          const ok = await applyKrispNoiseFilterFromDocs(localTrack, 'mic-pipeline')
          if (ok && !disposed) {
            sendInputStream = new MediaStream([localTrack.mediaStreamTrack])
          }
        }

        const micSource = ctx.createMediaStreamSource(sendInputStream)
        micSourceNodeRef.current = micSource
        const vadGate = ctx.createGain()
        vadGate.gain.value = 0
        vadGateGainRef.current = vadGate
        const userGain = ctx.createGain()
        userGain.gain.value = micGainRef.current
        micGainNodeRef.current = userGain
        const micDest = ctx.createMediaStreamDestination()
        sendMicStreamRef.current = micDest.stream
        micSource.connect(vadGate).connect(userGain).connect(micDest)

        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        ctx.createMediaStreamSource(rawStream).connect(analyser)
        localAnalyserRef.current = analyser

        void ctx.resume().catch(() => {})
        setIsReady(true)

        const base = vadAssetBase()
        try {
          const vad = await MicVAD.new({
            startOnLoad: false,
            model: 'v5',
            audioContext: ctx,
            getStream: async () => rawStream,
            pauseStream: async () => {},
            resumeStream: async () => rawStream,
            baseAssetPath: base,
            onnxWASMBasePath: base,
            processorType: 'AudioWorklet',
            onSpeechStart: () => {
              if (disposed || mutedRef.current) return
              setIsLocalSpeaking(true)
              const gv = vadGateGainRef.current
              if (gv && ctx.state !== 'closed') gv.gain.setTargetAtTime(1, ctx.currentTime, 0.02)
            },
            onSpeechEnd: () => {
              if (disposed) return
              setIsLocalSpeaking(false)
              const gv = vadGateGainRef.current
              if (gv && ctx.state !== 'closed' && !mutedRef.current) {
                gv.gain.setTargetAtTime(0, ctx.currentTime, 0.02)
              }
            },
            onVADMisfire: () => {
              if (disposed) return
              setIsLocalSpeaking(false)
              const gv = vadGateGainRef.current
              if (gv && ctx.state !== 'closed' && !mutedRef.current) {
                gv.gain.setTargetAtTime(0, ctx.currentTime, 0.02)
              }
            },
          })
          if (disposed) {
            await vad.destroy().catch(() => {})
            return
          }
          await vad.start()
          if (disposed) {
            await vad.destroy().catch(() => {})
            return
          }
          micVadRef.current = vad
          setVadBackend('silero')
        } catch (e) {
          console.warn('[mic] Silero VAD unavailable, using analyser gate:', e)
          if (!disposed) setVadBackend('analyser')
        }
      })
      .catch(err => console.error('[mic] createLocalAudioTrack failed:', err))

    return () => {
      disposed = true
      void (async () => {
        const vad = micVadRef.current
        micVadRef.current = null
        if (vad) await vad.destroy().catch(() => {})
        window.removeEventListener('pointerdown', resumeOnGesture)
        window.removeEventListener('keydown',     resumeOnGesture)
        window.removeEventListener('touchstart',  resumeOnGesture)
        sourceLocalAudioRef.current?.stop()
        sourceLocalAudioRef.current = null
        rawMicStreamRef.current = null
        sendMicStreamRef.current = null
        micSourceNodeRef.current = null
        micGainNodeRef.current = null
        vadGateGainRef.current = null
        localAnalyserRef.current = null
        await ctx.close()
      })()
    }
  }, [])

  // ── Speaking detection (analyser fallback when Silero did not load) ──────
  useEffect(() => {
    if (vadBackend !== 'analyser') return
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
      const gv = vadGateGainRef.current
      const actx = audioCtxRef.current
      if (gv && actx) {
        const target = speaking ? 1 : 0
        gv.gain.setTargetAtTime(target, actx.currentTime, 0.02)
      }
    }, 100)
    return () => clearInterval(id)
  }, [vadBackend])

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
      publishedClonesRef.current.forEach(t => { t.enabled = !next })
      if (next) {
        wasSpeaking.current = false
        speakingFrames.current = 0
        setIsLocalSpeaking(false)
        void micVadRef.current?.pause().catch(() => {})
        const gv = vadGateGainRef.current
        const actx = audioCtxRef.current
        if (gv && actx) gv.gain.setTargetAtTime(0, actx.currentTime, 0.02)
      } else {
        void micVadRef.current?.start().catch(() => {})
      }
      return next
    })
  }

  function setMicGain(value: number) {
    const next = Math.max(0, value)
    setMicGainState(next)
    micGainRef.current = next
    const node = micGainNodeRef.current
    const ctx = audioCtxRef.current
    if (node && ctx) node.gain.setTargetAtTime(next, ctx.currentTime, 0.03)
    try { localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(next)) } catch { /* ignore */ }
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
    rawMicStreamRef, sendMicStreamRef, audioCtxRef, micGainNodeRef, micSourceNodeRef, mutedRef, micGainRef,
    isMuted, toggleMute,
    micGain, setMicGain,
    isLocalSpeaking,
    headphonePrompt, confirmHeadphones,
    echoCancelEnabled, toggleEchoCancel,
    isReady,
    addPublishedClone, removePublishedClone,
  }
}
