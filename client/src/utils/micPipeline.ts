/**
 * LiveKit mic capture, Krisp attach, and Web Audio send-path graph.
 * Keeps one hardware MediaStreamSource fan-out (publish path + analyser tap).
 */

import { MicVAD } from '@ricky0123/vad-web'
import { createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client'
import { isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter'
import { applyKrispNoiseFilterFromDocs } from './voiceRoom'

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

/** Krisp expects browser noise suppression off when the filter is active. */
export function getMicCaptureOptions() {
  const krisp = isKrispNoiseFilterSupported()
  return {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: !krisp,
    ...(krisp ? { voiceIsolation: false } : {}),
  }
}

export function vadAssetBase(): string {
  const b = import.meta.env.BASE_URL || '/'
  return b.endsWith('/') ? b : `${b}/`
}

export type SendPathGraph = {
  micSource: MediaStreamAudioSourceNode
  vadGate: GainNode
  destination: MediaStreamAudioDestinationNode
  analyser: AnalyserNode
}

/**
 * micSource → vadGate → destination (what LiveKit publishes).
 * micSource → analyser (RMS fallback; no second MediaStreamSource).
 */
export function buildSendPathGraph(ctx: AudioContext, mediaStream: MediaStream): SendPathGraph {
  const micSource = ctx.createMediaStreamSource(mediaStream)
  const vadGate = ctx.createGain()
  vadGate.gain.value = 0
  const destination = ctx.createMediaStreamDestination()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  micSource.connect(vadGate)
  vadGate.connect(destination)
  micSource.connect(analyser)
  return { micSource, vadGate, destination, analyser }
}

export function teardownSendPathGraph(graph: SendPathGraph): void {
  try { graph.micSource.disconnect() } catch { /* ignore */ }
  try { graph.vadGate.disconnect() } catch { /* ignore */ }
  try { graph.analyser.disconnect() } catch { /* ignore */ }
}

export async function createCaptureTrackWithKrisp(
  krispLabel: string,
): Promise<{ capture: LocalAudioTrack; mediaStream: MediaStream }> {
  const capture = await createLocalAudioTrack(getMicCaptureOptions())
  const krispOk = await applyKrispNoiseFilterFromDocs(capture, krispLabel)
  if (!krispOk) console.warn('[mic] Krisp noise filter not active')
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
