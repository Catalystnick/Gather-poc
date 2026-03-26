/**
 * LiveKit mic capture (browser AEC / AGC / optional NS) + RNNoise worklet + VAD/send graph.
 * Chain: mic → [RNNoise] → vadGate → publish; same tail → analyser + tap stream for Silero.
 */

import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm'
import { MicVAD } from '@ricky0123/vad-web'
import { createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client'

export const AUDIO_SETTINGS_VERSION_KEY = 'gather_poc_audio_settings_version'
export const AUDIO_SETTINGS_VERSION     = '2026-03-native-v1'

let audioSettingsMigrationDone = false

export function runOnceAudioSettingsMigration(): void {
  if (audioSettingsMigrationDone) return
  audioSettingsMigrationDone = true
  try {
    localStorage.removeItem('gather_poc_mic_gain')
    if (localStorage.getItem(AUDIO_SETTINGS_VERSION_KEY) === AUDIO_SETTINGS_VERSION) return
    ;['gather_poc_remote_gain', 'gather_poc_rolloff',
      'gather_poc_gate_threshold', 'gather_poc_rnnoise'].forEach(k => localStorage.removeItem(k))
    localStorage.setItem(AUDIO_SETTINGS_VERSION_KEY, AUDIO_SETTINGS_VERSION)
  } catch { /* storage unavailable */ }
}

export function getAudioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  )
}

/**
 * WebRTC capture defaults — browser applies echo cancellation, noise suppression,
 * and auto gain where supported (Chrome: “noise cancellation” bundle).
 */
export function getMicCaptureOptions() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
}

export function vadAssetBase(): string {
  const b = import.meta.env.BASE_URL || '/'
  return b.endsWith('/') ? b : `${b}/`
}

export type SendPathGraph = {
  micSource: MediaStreamAudioSourceNode
  /** RNNoise AudioWorklet; null if worklet failed to load. */
  rnnoise: AudioWorkletNode | null
  /** Denoised stream for Silero only (not published directly). */
  vadTapDestination: MediaStreamAudioDestinationNode
  vadGate: GainNode
  destination: MediaStreamAudioDestinationNode
  analyser: AnalyserNode
}

function rnnoiseWorkletUrl(): string {
  return new URL('NoiseSuppressorWorklet.js', `${window.location.origin}${vadAssetBase()}`).href
}

/**
 * mic → [RNNoise?] → fan-out: vadGate → destination, analyser, vadTapDestination.
 */
export async function buildSendPathGraph(ctx: AudioContext, mediaStream: MediaStream): Promise<SendPathGraph> {
  const micSource = ctx.createMediaStreamSource(mediaStream)
  const vadGate = ctx.createGain()
  vadGate.gain.value = 0
  const destination = ctx.createMediaStreamDestination()
  const vadTapDestination = ctx.createMediaStreamDestination()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256

  let tail: AudioNode = micSource
  let rnnoise: AudioWorkletNode | null = null
  try {
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl())
    rnnoise = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name)
    micSource.connect(rnnoise)
    tail = rnnoise
  } catch (err) {
    console.warn('[mic] RNNoise worklet unavailable — continuing without it:', err)
  }

  tail.connect(vadGate)
  vadGate.connect(destination)
  tail.connect(analyser)
  tail.connect(vadTapDestination)

  return { micSource, rnnoise, vadTapDestination, vadGate, destination, analyser }
}

export function teardownSendPathGraph(graph: SendPathGraph): void {
  try { graph.micSource.disconnect() } catch { /* ignore */ }
  try { graph.rnnoise?.disconnect() } catch { /* ignore */ }
  try { graph.vadGate.disconnect() } catch { /* ignore */ }
  try { graph.analyser.disconnect() } catch { /* ignore */ }
  try { graph.vadTapDestination.disconnect() } catch { /* ignore */ }
}

export async function createCaptureTrack(): Promise<{ capture: LocalAudioTrack; mediaStream: MediaStream }> {
  const capture = await createLocalAudioTrack(getMicCaptureOptions())
  const mediaStream = capture.mediaStream ?? new MediaStream([capture.mediaStreamTrack])
  return { capture, mediaStream }
}

export async function startSileroVad(options: {
  ctx: AudioContext
  mediaStream: MediaStream
  vadGate: GainNode
  disposed: () => boolean
  isMuted: () => boolean
  setSpeaking: (speaking: boolean) => void
}): Promise<MicVAD | null> {
  const { ctx, mediaStream, vadGate, disposed, isMuted, setSpeaking } = options
  const base = vadAssetBase()

  function openGate() {
    if (disposed() || isMuted() || ctx.state === 'closed') return
    vadGate.gain.setTargetAtTime(1, ctx.currentTime, 0.02)
  }

  function closeGate() {
    if (disposed() || ctx.state === 'closed') return
    if (!isMuted()) vadGate.gain.setTargetAtTime(0, ctx.currentTime, 0.02)
  }

  try {
    return await MicVAD.new({
      startOnLoad: false,
      model: 'v5',
      positiveSpeechThreshold: 0.22,
      audioContext: ctx,
      getStream: async () => mediaStream,
      pauseStream: async () => {},
      resumeStream: async () => mediaStream,
      baseAssetPath: base,
      onnxWASMBasePath: base,
      processorType: 'AudioWorklet',
      onSpeechStart: () => {
        if (disposed() || isMuted()) return
        setSpeaking(true)
        openGate()
      },
      onSpeechEnd: () => {
        if (disposed()) return
        setSpeaking(false)
        closeGate()
      },
      onVADMisfire: () => {
        if (disposed()) return
        setSpeaking(false)
        closeGate()
      },
    })
  } catch (e) {
    console.warn('[mic] Silero VAD unavailable, using analyser gate:', e)
    return null
  }
}

/** RMS from byte frequency data (analyser fallback). Reuses `scratch` buffer each frame. */
export function analyserRms(analyser: AnalyserNode, scratch: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(scratch)
  let s = 0
  for (let i = 0; i < scratch.length; i++) s += scratch[i] * scratch[i]
  return Math.sqrt(s / scratch.length)
}
