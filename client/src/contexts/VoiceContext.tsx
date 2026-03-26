import { createContext, useContext } from 'react'
import type { VoiceMode } from '../hooks/useVoice'

export interface VoiceState {
  muted: boolean
  toggleMute: () => void
  micGain: number
  setMicGain: (v: number) => void
  isLocalSpeaking: boolean
  speakingPeers: Set<string>
  connectedPeers: Set<string>
  peerConnectionStates: Record<string, string>
  remoteGain: number
  setRemoteGain: (v: number) => void
  /** Linear multiplier (1–4) on remote voice; uses Web Audio gain when room has `webAudioMix`. */
  playbackBoost: number
  setPlaybackBoost: (v: number) => void
  krispEnabled: boolean
  /** Mirrors `useKrispNoiseFilter` from `@livekit/components-react/krisp` — implemented in Gather voice. */
  krispNoiseFilterPending: boolean
  setKrispNoiseFilterEnabled: (enabled: boolean) => void
  headphonePrompt: string | null
  confirmHeadphones: (accept: boolean) => void
  audioBlocked?: boolean
  audioInterrupted?: boolean
  mode: VoiceMode
  activeZoneKey: string | null
  proximityRoomReady?: boolean
}

const VoiceContext = createContext<VoiceState | null>(null)

export function useVoice(): VoiceState {
  const ctx = useContext(VoiceContext)
  if (!ctx) throw new Error('useVoice must be used within VoiceProvider')
  return ctx
}

export const VoiceProvider = VoiceContext.Provider
