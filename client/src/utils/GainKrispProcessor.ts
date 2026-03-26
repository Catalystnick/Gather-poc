import { KrispNoiseFilter } from '@livekit/krisp-noise-filter'
import { Track } from 'livekit-client'

type AudioProcessorOpts = {
  kind: Track.Kind
  track: MediaStreamTrack
  audioContext: AudioContext
  element?: HTMLMediaElement
}

// Processor chain: raw mic -> Krisp -> gain node -> encoder output track.
export class GainKrispProcessor {
  readonly name = 'gain-krisp'
  processedTrack?: MediaStreamTrack
  private krisp: ReturnType<typeof KrispNoiseFilter>
  private gainNode: GainNode
  private micSourceNode: MediaStreamAudioSourceNode
  private destNode?: MediaStreamAudioDestinationNode
  private krispSourceNode?: MediaStreamAudioSourceNode

  constructor(gainNode: GainNode, micSourceNode: MediaStreamAudioSourceNode) {
    this.krisp = KrispNoiseFilter()
    this.gainNode = gainNode
    this.micSourceNode = micSourceNode
  }

  async init(opts: AudioProcessorOpts): Promise<void> {
    await this.krisp.init(opts as Parameters<typeof this.krisp.init>[0])
    const krispOut = this.krisp.processedTrack
    if (!krispOut) throw new Error('[GainKrispProcessor] missing Krisp processedTrack')

    const ctx = this.gainNode.context as AudioContext
    try { this.micSourceNode.disconnect(this.gainNode) } catch { /* ignore */ }

    this.destNode = ctx.createMediaStreamDestination()
    this.krispSourceNode = ctx.createMediaStreamSource(new MediaStream([krispOut]))
    this.krispSourceNode.connect(this.gainNode).connect(this.destNode)
    this.processedTrack = this.destNode.stream.getAudioTracks()[0]
  }

  async destroy(): Promise<void> {
    await this.krisp.destroy()
    try { this.krispSourceNode?.disconnect(this.gainNode) } catch { /* ignore */ }
    try { if (this.destNode) this.gainNode.disconnect(this.destNode) } catch { /* ignore */ }
    this.krispSourceNode = undefined
    this.destNode = undefined
    this.processedTrack = undefined
  }
}
