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
      'gather_poc_gate_threshold', 'gather_poc_rnnoise'].forEach(storageKey => localStorage.removeItem(storageKey))
    localStorage.setItem(AUDIO_SETTINGS_VERSION_KEY, AUDIO_SETTINGS_VERSION)
  } catch { /* storage unavailable */ }
}

export function getAudioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  )
}

/** Create voice AudioContext, preferring 48kHz for Silero VAD compatibility. */
export function createVoiceAudioContext(): AudioContext {
  const AudioContextCtor = getAudioContextCtor() as unknown as {
    new (options?: AudioContextOptions): AudioContext
  }
  try {
    return new AudioContextCtor({ sampleRate: 48_000 })
  } catch {
    return new AudioContextCtor()
  }
}

/**
 * WebRTC capture: AEC + AGC; **noiseSuppression off** so RNNoise is the only broadband NS.
 * Stacking browser NS + RNNoise is a common cause of hollow / “underwater” timbre.
 */
export function getMicCaptureOptions() {
  return {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
  }
}

export function vadAssetBase(): string {
  const baseUrl = import.meta.env.BASE_URL || '/'
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export type SendPathGraph = {
  micSource: MediaStreamAudioSourceNode
  /** RNNoise AudioWorklet; null if worklet failed to load. */
  rnnoise: AudioWorkletNode | null
  /**
   * RNNoise is mono-in / mono-out on ch0; the worklet still exposes 2 outs with R silent.
   * `ChannelSplitter(1)` keeps only input channel 0; `ChannelMerger(2)` fans that bus to L+R.
   * (Same idea as duplicating `input[0]` to every `output[channel]` inside a tiny pass-through worklet.)
   */
  rnnoiseStereoFix: { splitter: ChannelSplitterNode; merger: ChannelMergerNode } | null
  /** Denoised stream for Silero only (not published directly). */
  vadTapDestination: MediaStreamAudioDestinationNode
  vadGate: GainNode
  destination: MediaStreamAudioDestinationNode
  analyser: AnalyserNode
  /** Biquad chain after RNNoise (warmth / presence / air); only when RNNoise is active. */
  postRnnoiseTone: { disconnect: () => void } | null
}

function rnnoiseWorkletUrl(): string {
  return new URL('NoiseSuppressorWorklet.js', `${window.location.origin}${vadAssetBase()}`).href
}

/** Silero tuning: softer fricatives (h, n, th) need lower thresholds + shorter min segment + longer hang-on. */
const VAD_POSITIVE_SPEECH_THRESHOLD = 0.14
const VAD_NEGATIVE_SPEECH_THRESHOLD = 0.08
const VAD_MIN_SPEECH_MS           = 200
const VAD_REDEMPTION_MS          = 2_000
const VAD_PRE_SPEECH_PAD_MS      = 1_000

/**
 * Light EQ after RNNoise to offset “hollow / tubby” denoising: trim sub-mud, add body, presence, air.
 * Gains are modest (~1–3 dB peaking / shelf) to avoid phasey or fatiguing sound.
 */
function connectPostRnnoiseToneShaping(ctx: AudioContext, fromNode: AudioNode): {
  output: AudioNode
  disconnect: () => void
} {
  const highPassFilter = ctx.createBiquadFilter()
  highPassFilter.type = 'highpass'
  highPassFilter.frequency.value = 85
  highPassFilter.Q.value = 0.707

  const warmth = ctx.createBiquadFilter()
  warmth.type = 'peaking'
  warmth.frequency.value = 380
  warmth.Q.value = 0.9
  warmth.gain.value = 1.8

  const presence = ctx.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2_600
  presence.Q.value = 0.85
  presence.gain.value = 3

  const air = ctx.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 7_000
  air.gain.value = 2.5

  fromNode.connect(highPassFilter)
  highPassFilter.connect(warmth)
  warmth.connect(presence)
  presence.connect(air)

  const toneNodes = [highPassFilter, warmth, presence, air]
  return {
    output: air,
    disconnect: () => {
      for (const node of toneNodes) try { node.disconnect() } catch { /* ignore */ }
    },
  }
}

/**
 * mic → [RNNoise?] → fan-out: vadGate → destination, analyser, vadTapDestination.
 * Uses the same `AudioContext` as the rest of the graph (usually 48 kHz in Chrome); avoid a separate
 * context at another rate or resamplers can skew pitch/latency relative to RNNoise’s frame size.
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
  let rnnoiseStereoFix: SendPathGraph['rnnoiseStereoFix'] = null
  let postRnnoiseTone: SendPathGraph['postRnnoiseTone'] = null
  try {
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl())
    rnnoise = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name)
    micSource.connect(rnnoise)
    const splitter = ctx.createChannelSplitter(1)
    const merger = ctx.createChannelMerger(2)
    rnnoise.connect(splitter)
    splitter.connect(merger, 0, 0)
    splitter.connect(merger, 0, 1)
    rnnoiseStereoFix = { splitter, merger }
    const tone = connectPostRnnoiseToneShaping(ctx, merger)
    postRnnoiseTone = { disconnect: tone.disconnect }
    tail = tone.output
  } catch (err) {
    console.warn('[mic] RNNoise worklet unavailable — continuing without it:', err)
  }

  tail.connect(vadGate)
  vadGate.connect(destination)
  tail.connect(analyser)
  tail.connect(vadTapDestination)

  return { micSource, rnnoise, rnnoiseStereoFix, postRnnoiseTone, vadTapDestination, vadGate, destination, analyser }
}

export function teardownSendPathGraph(graph: SendPathGraph): void {
  try { graph.vadGate.disconnect() } catch { /* ignore */ }
  try { graph.analyser.disconnect() } catch { /* ignore */ }
  try { graph.vadTapDestination.disconnect() } catch { /* ignore */ }
  graph.postRnnoiseTone?.disconnect()
  try { graph.rnnoiseStereoFix?.merger.disconnect() } catch { /* ignore */ }
  try { graph.rnnoiseStereoFix?.splitter.disconnect() } catch { /* ignore */ }
  try { graph.rnnoise?.disconnect() } catch { /* ignore */ }
  try { graph.micSource.disconnect() } catch { /* ignore */ }
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
      positiveSpeechThreshold: VAD_POSITIVE_SPEECH_THRESHOLD,
      negativeSpeechThreshold: VAD_NEGATIVE_SPEECH_THRESHOLD,
      minSpeechMs: VAD_MIN_SPEECH_MS,
      redemptionMs: VAD_REDEMPTION_MS,
      preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
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
  } catch (error) {
    console.warn(
      '[mic] Silero VAD unavailable (falling back to analyser gate) | sampleRate:',
      ctx.sampleRate,
      '| error:',
      error,
    )
    return null
  }
}

/** RMS from byte frequency data (analyser fallback). Reuses `scratch` buffer each frame. */
export function analyserRms(analyser: AnalyserNode, scratch: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(scratch)
  let sumSquares = 0
  for (let sampleIndex = 0; sampleIndex < scratch.length; sampleIndex++) {
    sumSquares += scratch[sampleIndex] * scratch[sampleIndex]
  }
  return Math.sqrt(sumSquares / scratch.length)
}
