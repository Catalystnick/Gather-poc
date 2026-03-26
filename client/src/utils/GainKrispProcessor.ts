// Shared audio processor: chains hardware mic → Krisp NC → gain node → encoded output.
// Used by both useLiveKitVoice (proximity) and useZoneVoice (zone rooms).
// Each room creates its own instance; destroy() is called on room disconnect.

import { KrispNoiseFilter } from '@livekit/krisp-noise-filter'
import type { Room } from 'livekit-client'
import { Track } from 'livekit-client'

type AudioProcessorOpts = {
  kind: Track.Kind
  track: MediaStreamTrack
  audioContext: AudioContext
  element?: HTMLMediaElement
}

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
    console.log('[Krisp] init — audioContext state:', opts.audioContext.state)
    await this.krisp.init(opts as Parameters<typeof this.krisp.init>[0])
    const krispOut = this.krisp.processedTrack
    if (!krispOut) throw new Error('[GainKrispProcessor] Krisp did not produce a processedTrack after init')
    console.log('[Krisp] init OK — processedTrack:', krispOut.label, '| readyState:', krispOut.readyState)

    // Use gainNode's own AudioContext — LiveKit supplies its own context in opts
    // which is different from the main audioCtx; mixing them causes InvalidAccessError.
    const ctx = this.gainNode.context as AudioContext
    try { this.micSourceNode.disconnect(this.gainNode) } catch { /* already disconnected */ }

    this.destNode = ctx.createMediaStreamDestination()
    this.krispSourceNode = ctx.createMediaStreamSource(new MediaStream([krispOut]))
    this.krispSourceNode.connect(this.gainNode).connect(this.destNode)
    this.processedTrack = this.destNode.stream.getAudioTracks()[0]
    console.log('[Krisp] audio graph rewired — chain: mic → Krisp → gain → dest')
  }

  async onPublish(room: Room): Promise<void> {
    console.log('[Krisp] onPublish — enabling NC')
    await this.krisp.onPublish(room)
    await this.krisp.setEnabled(true)
    console.log('[Krisp] NC enabled')
  }

  async restart(opts: AudioProcessorOpts): Promise<void> {
    console.log('[Krisp] restart')
    await this.destroy()
    await this.init(opts)
  }

  async destroy(): Promise<void> {
    console.log('[Krisp] destroy — disconnecting Krisp audio chain')
    await this.krisp.destroy()
    // Disconnect only what this processor owns. Do NOT reconnect micSourceNode → gainNode:
    // that would bypass Krisp and feed raw (noisy) audio into the proximity room's chain.
    try { this.krispSourceNode?.disconnect(this.gainNode) } catch { /* ignore */ }
    try { if (this.destNode) this.gainNode.disconnect(this.destNode) } catch { /* ignore */ }
    this.krispSourceNode = undefined
    this.destNode = undefined
    this.processedTrack = undefined
  }
}
