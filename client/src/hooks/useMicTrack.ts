// Local mic: LiveKit capture + Krisp + Web Audio VAD gate → LiveKit publish stream.
// Graph: one MediaStreamSource → vadGate → MediaStreamDestination (send), parallel → Analyser (fallback).
// Heavy setup lives in `utils/micPipeline.ts`; this hook owns React state and lifecycle.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalAudioTrack } from 'livekit-client'
import { MicVAD } from '@ricky0123/vad-web'
import {
  runOnceAudioSettingsMigration,
  getAudioContextCtor,
  buildSendPathGraph,
  teardownSendPathGraph,
  createCaptureTrackWithKrisp,
  startSileroVad,
  analyserRms,
  type SendPathGraph,
} from '../utils/micPipeline'

const SPEAKING_THRESHOLD         = 20
const SPEAKING_HYSTERESIS_UP     = 2
const SPEAKING_HYSTERESIS_DOWN = 5

export interface MicTrack {
  rawMicStreamRef: React.MutableRefObject<MediaStream | null>
  sendMicStreamRef: React.MutableRefObject<MediaStream | null>
  audioCtxRef: React.MutableRefObject<AudioContext | null>
  mutedRef: React.MutableRefObject<boolean>
  isMuted: boolean
  toggleMute: () => void
  isLocalSpeaking: boolean
  headphonePrompt: string | null
  confirmHeadphones: (accept: boolean) => void
  echoCancelEnabled: boolean
  toggleEchoCancel: () => void
  isReady: boolean
  addPublishedClone: (track: MediaStreamTrack) => void
  removePublishedClone: (track: MediaStreamTrack) => void
}

export function useMicTrack(): MicTrack {
  const [isMuted, setIsMuted] = useState(false)
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false)
  const [headphonePrompt, setHeadphonePrompt] = useState<string | null>(null)
  const [echoCancelEnabled, setEchoCancelEnabled] = useState(true)
  const [isReady, setIsReady] = useState(false)
  const [vadBackend, setVadBackend] = useState<'silero' | 'analyser' | null>(null)

  const rawMicStreamRef = useRef<MediaStream | null>(null)
  const sendMicStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const graphRef = useRef<SendPathGraph | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  const mutedRef = useRef(false)
  const echoCancelRef = useRef(true)
  const speakingFrames = useRef(0)
  const wasSpeaking = useRef(false)
  const prevOutputIds = useRef<Set<string>>(new Set())
  const headphoneIdRef = useRef<string | null>(null)
  const publishedClonesRef = useRef<Set<MediaStreamTrack>>(new Set())
  const captureRef = useRef<LocalAudioTrack | null>(null)
  const micVadRef = useRef<MicVAD | null>(null)

  useEffect(() => {
    runOnceAudioSettingsMigration()

    let disposed = false
    const isDisposed = () => disposed

    const ctx = new (getAudioContextCtor())()
    audioCtxRef.current = ctx
    void ctx.resume().catch(() => {})

    const resumeOnGesture = () => void ctx.resume().catch(() => {})
    window.addEventListener('pointerdown', resumeOnGesture)
    window.addEventListener('keydown', resumeOnGesture)
    window.addEventListener('touchstart', resumeOnGesture, { passive: true })

    if ('audioSession' in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'play-and-record'
    }

    if (!navigator.mediaDevices) {
      void ctx.close()
      audioCtxRef.current = null
      window.removeEventListener('pointerdown', resumeOnGesture)
      window.removeEventListener('keydown', resumeOnGesture)
      window.removeEventListener('touchstart', resumeOnGesture)
      return () => {}
    }

    void (async () => {
      let capture: LocalAudioTrack | null = null
      try {
        const { capture: cap, mediaStream } = await createCaptureTrackWithKrisp('capture')
        capture = cap
        if (disposed) {
          cap.stop()
          return
        }
        captureRef.current = cap
        rawMicStreamRef.current = mediaStream

        const graph = buildSendPathGraph(ctx, mediaStream)
        graphRef.current = graph
        analyserRef.current = graph.analyser
        sendMicStreamRef.current = graph.destination.stream

        void ctx.resume().catch(() => {})
        setIsReady(true)

        const vad = await startSileroVad({
          ctx,
          mediaStream,
          vadGate: graph.vadGate,
          disposed: isDisposed,
          isMuted: () => mutedRef.current,
          setSpeaking: setIsLocalSpeaking,
        })
        if (disposed) {
          await vad?.destroy().catch(() => {})
          return
        }
        if (vad) {
          await vad.start()
          if (disposed) {
            await vad.destroy().catch(() => {})
            return
          }
          micVadRef.current = vad
          setVadBackend('silero')
        } else {
          setVadBackend('analyser')
        }
      } catch (err) {
        console.error('[mic] setup failed:', err)
        if (capture) capture.stop()
      }
    })()

    return () => {
      disposed = true
      void (async () => {
        const vad = micVadRef.current
        micVadRef.current = null
        if (vad) await vad.destroy().catch(() => {})

        window.removeEventListener('pointerdown', resumeOnGesture)
        window.removeEventListener('keydown', resumeOnGesture)
        window.removeEventListener('touchstart', resumeOnGesture)

        const g = graphRef.current
        graphRef.current = null
        if (g) teardownSendPathGraph(g)

        analyserRef.current = null
        captureRef.current?.stop()
        captureRef.current = null
        rawMicStreamRef.current = null
        sendMicStreamRef.current = null

        await ctx.close().catch(() => {})
        audioCtxRef.current = null
        setIsReady(false)
        setVadBackend(null)
      })()
    }
  }, [])

  useEffect(() => {
    if (vadBackend !== 'analyser') return
    let cancelled = false
    const scratch = new Uint8Array(new ArrayBuffer(128))

    function tick() {
      if (cancelled) return
      const analyser = analyserRef.current
      const actx = audioCtxRef.current
      const gv = graphRef.current?.vadGate
      if (analyser && actx && gv) {
        const rms = analyserRms(analyser, scratch)
        const above = rms > SPEAKING_THRESHOLD
        speakingFrames.current = above
          ? Math.min(SPEAKING_HYSTERESIS_UP, speakingFrames.current + 1)
          : Math.max(-SPEAKING_HYSTERESIS_DOWN, speakingFrames.current - 1)
        const speaking = !mutedRef.current && (
          speakingFrames.current >= SPEAKING_HYSTERESIS_UP ||
          (wasSpeaking.current && speakingFrames.current > -SPEAKING_HYSTERESIS_DOWN)
        )
        wasSpeaking.current = speaking
        setIsLocalSpeaking(speaking)
        const target = speaking ? 1 : 0
        gv.gain.setTargetAtTime(target, actx.currentTime, 0.02)
      }
      if (!cancelled) requestAnimationFrame(tick)
    }

    const id = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [vadBackend])

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return
    let cancelled = false

    void navigator.mediaDevices.enumerateDevices().then(devs => {
      if (cancelled) return
      prevOutputIds.current = new Set(devs.filter(d => d.kind === 'audiooutput').map(d => d.deviceId))
    }).catch(() => {})

    async function onDeviceChange() {
      if (cancelled) return
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const outputs = devs.filter(d => d.kind === 'audiooutput')
        const newIds = new Set(outputs.map(d => d.deviceId))
        const appeared = outputs.filter(
          d => !prevOutputIds.current.has(d.deviceId) && d.deviceId !== 'default' && d.deviceId !== 'communications',
        )
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
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
  }, [])

  const addPublishedClone = useCallback((track: MediaStreamTrack) => {
    publishedClonesRef.current.add(track)
    track.enabled = !mutedRef.current
  }, [])

  const removePublishedClone = useCallback((track: MediaStreamTrack) => {
    publishedClonesRef.current.delete(track)
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev
      mutedRef.current = next
      publishedClonesRef.current.forEach(t => { t.enabled = !next })
      const gv = graphRef.current?.vadGate
      const actx = audioCtxRef.current
      if (next) {
        wasSpeaking.current = false
        speakingFrames.current = 0
        setIsLocalSpeaking(false)
        void micVadRef.current?.pause().catch(() => {})
        if (gv && actx) gv.gain.setTargetAtTime(0, actx.currentTime, 0.02)
      } else {
        void micVadRef.current?.start().catch(() => {})
      }
      return next
    })
  }, [])

  const confirmHeadphones = useCallback(async (accept: boolean) => {
    setHeadphonePrompt(null)
    if (!accept) {
      headphoneIdRef.current = null
      return
    }
    setEchoCancelEnabled(false)
    echoCancelRef.current = false
    const track = rawMicStreamRef.current?.getAudioTracks()[0]
    await track?.applyConstraints({ echoCancellation: false }).catch(() => {})
  }, [])

  const toggleEchoCancel = useCallback(async () => {
    const next = !echoCancelRef.current
    setEchoCancelEnabled(next)
    echoCancelRef.current = next
    const track = rawMicStreamRef.current?.getAudioTracks()[0]
    if (track) await track.applyConstraints({ echoCancellation: next }).catch(() => {})
  }, [])

  return {
    rawMicStreamRef,
    sendMicStreamRef,
    audioCtxRef,
    mutedRef,
    isMuted,
    toggleMute,
    isLocalSpeaking,
    headphonePrompt,
    confirmHeadphones,
    echoCancelEnabled,
    toggleEchoCancel,
    isReady,
    addPublishedClone,
    removePublishedClone,
  }
}
