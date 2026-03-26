import { KrispNoiseFilter } from '@livekit/krisp-noise-filter'
import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client'

// Krisp output (or raw mic if Krisp off / unsupported) → dedicated GainNode → publish.
// Each LiveKit room gets its own processor instance — no shared GainNode between rooms.

export class KrispWithMicGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'krisp-with-mic-gain'
  processedTrack?: MediaStreamTrack
  private krisp?: ReturnType<typeof KrispNoiseFilter>
  private gainNode?: GainNode
  private srcNode?: MediaStreamAudioSourceNode
  private destNode?: MediaStreamAudioDestinationNode

  constructor(
    private readonly micGainRef: { current: number },
    private readonly postGainOut: { current: GainNode | null },
    private readonly useKrisp: boolean,
  ) {}

  init = async (opts: AudioProcessorOptions): Promise<void> => {
    const ctx = opts.audioContext
    const gain = ctx.createGain()
    gain.gain.value = Math.max(0, this.micGainRef.current)
    this.gainNode = gain
    const dest = ctx.createMediaStreamDestination()
    this.destNode = dest

    if (this.useKrisp) {
      this.krisp = KrispNoiseFilter()
      await this.krisp.init(opts)
      const kOut = this.krisp.processedTrack
      if (!kOut) throw new Error('[KrispWithMicGain] missing Krisp processedTrack')
      this.srcNode = ctx.createMediaStreamSource(new MediaStream([kOut]))
    } else {
      this.srcNode = ctx.createMediaStreamSource(new MediaStream([opts.track]))
    }
    this.srcNode.connect(gain).connect(dest)
    const out = dest.stream.getAudioTracks()[0]
    if (!out) throw new Error('[KrispWithMicGain] no output track')
    this.processedTrack = out
    this.postGainOut.current = gain
  }

  restart = async (opts: AudioProcessorOptions): Promise<void> => {
    await this.destroy()
    await this.init(opts)
  }

  destroy = async (): Promise<void> => {
    this.postGainOut.current = null
    try { this.srcNode?.disconnect() } catch { /* ignore */ }
    try {
      if (this.gainNode && this.destNode) this.gainNode.disconnect(this.destNode)
    } catch { /* ignore */ }
    this.srcNode = undefined
    this.gainNode = undefined
    this.destNode = undefined
    this.processedTrack = undefined
    if (this.krisp) {
      await this.krisp.destroy()
      this.krisp = undefined
    }
  }
}
